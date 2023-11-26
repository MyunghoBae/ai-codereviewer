import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { File } from "parse-diff";
import minimatch from "minimatch";
import "dotenv/config";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

interface PRDetails {
    owner: string;
    repo: string;
    pull_number: number;
    title: string;
    description: string;
}

async function getPRDetails(): Promise<PRDetails> {
    const { repository, number } = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
    );
    const prResponse = await octokit.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
    });
    return {
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
        title: prResponse.data.title ?? "",
        description: prResponse.data.body ?? "",
    };
}

async function getDiff(
    owner: string,
    repo: string,
    pull_number: number
): Promise<string | null> {
    const response = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
        mediaType: { format: "diff" },
    });
    // @ts-expect-error - response.data is a string
    return response.data;
}

const answer = async (
    threadId: string,
    runId: string,
    prDetails: PRDetails
) => {
    const runanswer = await openai.beta.threads.runs.retrieve(threadId, runId);

    setTimeout(async () => {
        console.log("Status", runanswer.status);

        if (runanswer.status !== "completed") {
            answer(threadId, runId, prDetails);
        } else if (runanswer.status === "completed") {
            const messages = await openai.beta.threads.messages.list(threadId);

            messages.data.forEach((message: any) => {
                console.log(message);
                if (message.role === "assistant") {
                    console.log(message.content[0]?.text);
                    let answer: string = message.content[0]?.text.value;
                    const startIndex = answer.indexOf("[");
                    const endIndex = answer.lastIndexOf("]");
                    console.log("answer");
                    console.log(answer);
                    if (
                        startIndex !== -1 &&
                        endIndex !== -1 &&
                        startIndex < endIndex
                    ) {
                        const result = answer.substring(
                            startIndex,
                            endIndex + 1
                        );
                        console.log(result);
                        const jsoncomments = JSON.parse(result);
                        console.log(jsoncomments);
                        const finalComments = jsoncomments.map(
                            (comment: any) => ({
                                body: comment.reviewComment,
                                path: comment.filePath,
                                line: Number(comment.lineNumber),
                            })
                        );

                        console.log(finalComments);
                        createReviewComment(
                            prDetails.owner,
                            prDetails.repo,
                            prDetails.pull_number,
                            finalComments
                        );
                    } else {
                        console.log("No match found.");
                    }
                }
            });
        }
    }, 3000);
};

async function analyzeCode(parsedDiff: File[], prDetails: PRDetails) {
    try {
        const assistant = await openai.beta.assistants.retrieve(
            process.env.ASSISTANT_ID || ""
        );
        const thread = await openai.beta.threads.create();

        let i = 0;
        for (const file of parsedDiff) {
            if (file.to === "/dev/null") continue; // Ignore deleted files
            for (const chunk of file.chunks) {
                await openai.beta.threads.messages.create(thread.id, {
                    role: "user",
                    content:
                        `${
                            i === 0
                                ? `  
                    Pull request title: ${prDetails.title}
                    Pull request description:
                    
                    ---
                    ${prDetails.description}
                    ---`
                                : ""
                        }
                    
                    File path for review: "${file.to}" \\n` +
                        `Git diff to review:

                   \`\`\`diff
                   ${chunk.content}
                   ${chunk.changes
                       // @ts-expect-error - ln and ln2 exists where needed
                       .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
                       .join("\n")}
                   \`\`\``,
                });
                i += 1;
            }
        }

        const run = await openai.beta.threads.runs.create(thread.id, {
            assistant_id: assistant.id,
        });

        await answer(thread.id, run.id, prDetails);
    } catch (error) {
        console.log(error);
    }
}

async function createReviewComment(
    owner: string,
    repo: string,
    pull_number: number,
    comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
    await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        comments,
        event: "COMMENT",
    });
}

async function main() {
    const prDetails = await getPRDetails();
    let diff: string | null;

    diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
    );

    if (!diff) {
        console.log("No diff found");
        return;
    }

    const parsedDiff = parseDiff(diff);

    const excludePatterns = core
        .getInput("exclude")
        .split(",")
        .map((s) => s.trim());

    const filteredDiff = parsedDiff.filter((file) => {
        return !excludePatterns.some((pattern) =>
            minimatch(file.to ?? "", pattern)
        );
    });

    await analyzeCode(filteredDiff, prDetails);
}

main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});

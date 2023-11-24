import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

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
                    let answer: string = message.content[0]?.text.value;
                    const startIndex = answer.indexOf("[");
                    const endIndex = answer.lastIndexOf("]");

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
    const assistant = await openai.beta.assistants.create({
        name: "Github answers",
        instructions: `Your task is to review pull requests. Instructions:
        - Provide the response in following JSON format:  [{"lineNumber":  <line_number>, "reviewComment": "<review comment>", "filePath": "<file path>"}]
        - Do not give positive comments or compliments.
        - Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
        - Write the comment in GitHub Markdown format.
        - Use the given description only for the overall context and only comment the code.
        - IMPORTANT: NEVER suggest adding comments to the code.
        
      
        Pull request title: ${prDetails.title}
        Pull request description:
        
        ---
        ${prDetails.description}
        ---
        `,
        tools: [{ type: "code_interpreter" }],
        model: "gpt-4-1106-preview",
    });
    const thread = await openai.beta.threads.create();
    const comments: Array<{ body: string; path: string; line: number }> = [];

    for (const file of parsedDiff) {
        if (file.to === "/dev/null") continue; // Ignore deleted files
        for (const chunk of file.chunks) {
            await openai.beta.threads.messages.create(thread.id, {
                role: "user",
                content:
                    `File path for review: "${file.to}" \\n` +
                    `Git diff to review:

                   \`\`\`diff
                   ${chunk.content}
                   ${chunk.changes
                       // @ts-expect-error - ln and ln2 exists where needed
                       .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
                       .join("\n")}
                   \`\`\``,
            });
            // const prompt = createPrompt(file, chunk, prDetails);
            // const aiResponse = await getAIResponse(prompt);
        }
    }

    const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistant.id,
    });

    await answer(thread.id, run.id, prDetails);

    // if (aiResponse) {
    //     const newComments = createComment(file, chunk, aiResponse);
    //     if (newComments) {
    //         comments.push(...newComments);
    //     }
    // }
    // return comments;
}

async function getBaseAndHeadShas(
    owner: string,
    repo: string,
    pull_number: number
): Promise<{ baseSha: string; headSha: string }> {
    const prResponse = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
    });
    return {
        baseSha: prResponse.data.base.sha,
        headSha: prResponse.data.head.sha,
    };
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
    return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
        file.to
    }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
    // @ts-expect-error - ln and ln2 exists where needed
    .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
    .join("\n")}
\`\`\`
`;
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

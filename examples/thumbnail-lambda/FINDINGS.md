# Findings from the thumbnail example

Thank you for taking the time to read this. While building this example (Copilot wrote the Terraform, Claude wrote the Python app), we learned a few things that we hope will save you some effort. We have tried to be candid about what worked and what did not, so you can judge how far to trust the numbers.

The main [README](README.md) describes the project itself. This page only collects the lessons.

## In short

- **The hybrid approach can save tokens, but only with a particular workflow.** In our run it reduced Claude's output by about 40%. A careless version of the same idea cost about 13% more than not using Copilot at all.
- **The absolute saving was modest.** Around 1,600 tokens on a project of about 10 KB. We would not call it dramatic for a one-off task.
- **The numbers are estimates from a single run.** Please read them as an illustration rather than a benchmark.

## What we measured

Token counts are estimated at 3.5 characters per token for code. Real tokenisation differs, so the percentages are more trustworthy than the absolute values.

| Approach | Claude output tokens (approx.) | Compared with Claude doing everything |
|---|---:|---|
| Claude writes everything | 4,000 | baseline |
| Hybrid, reply saved to disk and turned into files by script | 2,400 | about 40% fewer |
| Hybrid, Claude reads Copilot's reply and re-types it | 4,530 | about 13% more, plus around 2,150 input tokens |

For the baseline we assumed Claude's Terraform would be about the same size as Copilot's, so the 40% depends on that assumption.

## What we learned

### 1. How the reply travels matters more than who writes the code

The saving appeared because Copilot's Terraform (roughly 2,100 tokens) never passed through Claude. The bridge saved the reply as JSON, and a small script, [`scripts/extract-code.mjs`](../../scripts/extract-code.mjs), wrote the files. Claude only paid for a short spec (about 530 tokens) and a 300-character preview.

If the reply is read into the conversation and then written out again, both the reading and the re-typing are paid for, and the result is worse than doing the work directly. We would gently suggest always using `save` together with a small `maxChars` for generated code.

### 2. A short contract keeps the two halves compatible

We wrote a few lines of interface into the prompt: the handler name, environment variables, S3 prefixes, the build directory, and the image content types. Copilot's output then matched the Python code without any rework. Without such a contract we would expect mismatches and extra rounds.

### 3. Leverage grows with the size of the generated part

Here the spec was about a quarter of the size of the code it produced. A larger infrastructure, or a task repeated many times, should benefit more. For a small one-off, the setup effort may outweigh the saving.

### 4. Generated output still needs checking

`terraform validate` and `terraform fmt -check` passed, and our 8 unit tests pass. However, we did **not** run `terraform apply`, so the infrastructure has not been exercised against a real AWS account. Please review the IAM policy and the API Gateway settings before deploying.

## Problems we found in the bridge (now fixed)

We hope these notes help anyone with a similar setup.

- **Long prompts failed.** Copilot's chat input is now a rich-text editor. Typing key by key was too slow for long prompts, and a plain newline would have sent the message half-written. The bridge now inserts text line by line and uses Shift+Enter between lines.
- **Code copied from Copilot contained hidden characters.** Its code editor uses non-breaking spaces on blank lines, which made Terraform reject the files. The bridge now replaces them with ordinary spaces.
- **A false "authenticated" status.** An earlier check only looked at the URL, so a sign-in page counted as signed in. The check now requires a visible chat input.

## What we did not measure

- Time spent by a person or by Claude on defining the contract, reviewing, and debugging.
- Differences in quality between Copilot's and Claude's code.
- Cost in money. Output and input tokens are priced differently, and we have not applied any price list.
- More than one task. A larger sample would give a more reliable picture.

## Suggestions if you try this yourself

1. Write a short contract first (names, variables, paths, formats).
2. Ask Copilot for one code block per file, each starting with `# file: <name>`.
3. Call `ask_copilot` with `save: ["json"]` and a small `maxChars`.
4. Run `node scripts/extract-code.mjs output/<reply>.json <folder>`.
5. Validate the result with the usual tools, and review it before deploying.

If you spot a mistake in our reasoning or have measurements of your own, we would be glad to hear about them.

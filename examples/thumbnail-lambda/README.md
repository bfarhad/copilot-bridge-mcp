# Example: thumbnail service — infra by Copilot, app by Claude

A small but real project built to measure what the [copilot-bridge](../../README.md) saves in practice.

**What it is:** `POST /thumbnails` with raw image bytes (JPEG/PNG/WebP) → API Gateway (API key required) → Lambda (Python 3.12 + Pillow) → original and 256 px thumbnail stored in a private S3 bucket → JSON with a presigned thumbnail URL.

```
client ──x-api-key──▶ API Gateway (REST, usage plan) ──▶ Lambda ──▶ S3 (originals/, thumbnails/)
                                                            └──▶ { thumbnail_url (presigned), id, ... }
```

| Part | Written by | Files |
|---|---|---|
| Infra / design (Terraform) | **Copilot**, through the bridge | `terraform/*.tf` |
| App code, build, tests | **Claude** | `src/handler.py`, `requirements.txt`, `scripts/build.sh`, `tests/` |

The two sides meet at a short contract that Claude wrote into the Copilot prompt: handler `handler.lambda_handler`, env vars `BUCKET_NAME`, `THUMB_SIZE`, `URL_EXPIRY_SECONDS`, package directory `../build`, S3 prefixes `originals/` and `thumbnails/`, binary media types for the three image formats.

For the lessons learned (including what went wrong and what we did not measure), see [FINDINGS.md](FINDINGS.md).

## Workflow used

```text
1. Claude → ask_copilot(prompt = infra spec, save = ["json"], maxChars = 300)
              Copilot's full reply is written to output/<name>.json;
              only a 300-character preview enters Claude's context.
2. node ../../scripts/extract-code.mjs ../../output/<name>.json terraform/
              Code blocks marked `# file: <name>` become files. No LLM involved.
3. terraform init && terraform validate && terraform fmt -check      → valid
4. Claude writes src/handler.py + tests; pytest                      → 8 passed
```

## Run it

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install pillow==11.0.0 boto3 pytest
pytest -q tests                      # unit tests (S3 is faked)

./scripts/build.sh                   # builds ./build with a Linux Pillow wheel
cd terraform && terraform init && terraform apply
# then:
curl -X POST "$(terraform output -raw api_url)" \
  -H "x-api-key: $(terraform output -raw api_key_value)" \
  -H "Content-Type: image/jpeg" --data-binary @photo.jpg
```

`terraform apply` creates billable AWS resources — it was **not** run for this example; only `validate`/`fmt` and the unit tests were.

## Token measurement

One run, one project — treat it as an illustration, not a benchmark. Token counts are **estimates** (characters ÷ 3.5 for code; ÷ 4 gives numbers about 12% lower with the same percentages). Real Claude tokenisation differs.

| Quantity | Characters | ≈ Tokens (÷3.5) |
|---|---:|---:|
| Copilot's Terraform (4 files) | 7,462 | 2,130 |
| Claude's spec prompt for Copilot | 1,868 | 530 |
| Claude's app code + build + tests | 6,537 | 1,870 |
| Preview of the reply that entered Claude's context | 300 | 86 |

Claude's **output** tokens (the expensive direction) under three ways of working:

| Approach | Output tokens | Extra input tokens | vs. all-Claude |
|---|---:|---:|---|
| **A. Claude writes everything** (baseline: Terraform estimated at the same size as Copilot's) | ~4,000 | — | — |
| **B. Hybrid, `save` + `extract-code.mjs`** (this example) | ~2,400 | ~90 | **−40 % output** |
| **C. Hybrid, naive: read Copilot's reply, then rewrite it into files** | ~4,530 | ~2,150 | **+13 % output**, plus input |

What this shows:

- **The saving comes from not re-typing generated code.** The Terraform (~2,100 tokens) never passes through Claude. The spec costs ~530 tokens, roughly a 4:1 leverage that grows with the size of the infra.
- **Without `save`/extraction (C) the hybrid is worse than doing everything in Claude.** The bridge only pays off if the reply goes to disk, not through the model.
- **In absolute terms this is small:** ~1,600 tokens on a ~10 KB project. It becomes meaningful for large IaC or when the same step repeats many times — not "dramatic" for a one-off.
- **Not counted:** the time Claude spent defining the contract, validating the output, and fixing bridge bugs found along the way (a prompt-input bug and non-breaking spaces in Copilot's code blocks — both fixed in the bridge). Copilot's own quality still needs a human/Claude check; here `terraform validate` passed on the first extraction after the whitespace fix, but the config has not been applied.

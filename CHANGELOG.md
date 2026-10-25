# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The version lives in `package.json`;
the status page (`/`), `/version`, `/health`, the `get_status` tool and the MCP server info all report it.

## 0.3.3

- Security: DNS-rebinding protection — requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` are rejected with `403`; extend with `ALLOWED_HOSTS`.
- Dependencies: `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, `express` 5.3.0 (pulls `body-parser` 2.4.0); `npm audit` reports 0 vulnerabilities.
- Thumbnail example: Pillow 13.0.0; `build.sh` targets `manylinux_2_28_x86_64` (Pillow 13 ships no `manylinux2014` wheels; the Lambda Python 3.12 runtime is Amazon Linux 2023).

## 0.3.2

- `scripts/run.sh` and `scripts/run.bat` ask which option to use (A: Node.js, B: Docker) and mark unavailable options; `menu`, `node`, `docker`, `auto` and `stop` arguments skip or replace the menu.
- Port-conflict handling when switching between the two options; the Docker option verifies that the container can reach Edge through the proxy.

## 0.3.1

- CDP mode: `POST /auth/cookies` and `/auth/sync` are rejected with an explanation instead of writing cookies into your Edge.
- CDP mode: a failed session check no longer closes your Copilot tab.
- CDP mode: the bridge re-checks the session on the next call instead of staying in `error` until restart; new `POST /auth/recheck` and a Re-check button on the status page.
- Status page and messages no longer tell CDP users to run `sync-cookies.mjs`.

## 0.3.0

- `ask_copilot`: `systemPrompt`, `format: "json"`, `timeoutMs`, `retries`, `dryRun`.
- New tool `ask_copilot_batch`: up to 10 prompts in order.
- `review_code`: `files`, `focus`, `minSeverity`, `outputFormat` (`markdown`, `findings-json`, `patch`), `timeoutMs`, `retries`, `dryRun`.
- `get_status`: Edge reachability, open tab, queue length, call counters and latency, `refresh` option.
- `docs/ai-assistant-guide.md`: quick guide for AI assistants.

## 0.2.0

- Show the version and build commit on the status page; add `GET /version`; include the version in `/health` and `get_status`.
- Run scripts for macOS/Linux (`scripts/run.sh`) and Windows (`scripts/run.bat`) that choose between running with host Node.js and running in Docker.
- Merge the concept notes into the editor setup guide.

## 0.1.0

- Initial release: `ask_copilot`, `review_code`, `get_status` over MCP Streamable HTTP, driving a signed-in Edge over CDP.

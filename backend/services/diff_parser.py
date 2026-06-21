import fnmatch
import httpx
import sentry_sdk

from backend.config import GITHUB_TOKEN

# File extensions to keep — ignore everything else.
ALLOWED_EXTENSIONS = {
    ".py", ".ts", ".js", ".tsx", ".jsx", ".go", ".rs", ".java", ".cpp", ".c", ".cs",
}

# Patterns that indicate generated/lock files — skip these.
SKIP_PATTERNS = [
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "Cargo.lock", "go.sum",
    "*.min.js", "*.min.css", "__pycache__", ".pyc",
]


async def fetch_and_parse_diff(
    repo_full_name: str, pr_number: int, *, access_token: str = ""
) -> str:
    """
    Fetch + clean a PR diff. `access_token` is the per-request user's OAuth
    token (preferred). Falls back to the env `GITHUB_TOKEN` if no token is
    supplied — useful for one-off scripts and cron background sync.
    Returns cleaned diff text or empty string if nothing useful is found.
    """
    url = f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
    headers = {"Accept": "application/vnd.github.v3.diff"}
    token = access_token or GITHUB_TOKEN
    if token:
        headers["Authorization"] = f"Bearer {token}"

    async with httpx.AsyncClient() as client:
        response = await client.get(url, headers=headers, timeout=15.0)
        response.raise_for_status()
        raw_diff = response.text

    cleaned = clean_diff(raw_diff)

    sentry_sdk.add_breadcrumb(
        category="diff_parser",
        message=(
            f"Parsed PR #{pr_number}: {len(raw_diff)} chars raw "
            f"→ {len(cleaned)} chars cleaned"
        ),
        level="info",
    )

    return cleaned


def clean_diff(raw_diff: str) -> str:
    """
    Filter a unified diff to only include hunks from allowed file types.
    Strip binary file notices, whitespace-only hunks, and generated files.
    """
    lines = raw_diff.split("\n")
    output_lines = []
    current_file_allowed = False

    for line in lines:
        # Detect file header.
        if line.startswith("diff --git"):
            filename = line.split(" b/")[-1] if " b/" in line else ""
            current_file_allowed = any(
                filename.endswith(ext) for ext in ALLOWED_EXTENSIONS
            ) and not any(
                # P2-B9: use fnmatch so the glob patterns in SKIP_PATTERNS
                # (e.g. "*.min.js") actually match anywhere in the path,
                # not just when stripped of `*` they happen to appear as
                # a substring.
                fnmatch.fnmatch(filename, pat) for pat in SKIP_PATTERNS
            )
            if current_file_allowed:
                output_lines.append(line)
            continue

        if not current_file_allowed:
            continue

        # Skip binary file notices.
        if line.startswith("Binary files"):
            continue

        # Skip lines that are purely whitespace changes.
        if line in ("+", "-", "+ ", "- "):
            continue

        output_lines.append(line)

    return "\n".join(output_lines).strip()

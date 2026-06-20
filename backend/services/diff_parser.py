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


async def fetch_and_parse_diff(repo_full_name: str, pr_number: int) -> str:
    """
    Fetch the unified diff for a PR from the GitHub API.
    Returns cleaned diff text or empty string if nothing useful is found.
    """
    url = f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
    headers = {"Accept": "application/vnd.github.v3.diff"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"

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
                pat.replace("*", "") in filename for pat in SKIP_PATTERNS
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

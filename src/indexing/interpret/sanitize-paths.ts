// Local file-path redaction for provider-bound text. Extracted from task-extraction so any LLM
// consumer can reuse it. Claude Code's prompt mode (`claude -p`) treats local-looking paths and
// `file://` URLs in its input as files or media to open — which both leaks the local path to the
// model and, on macOS, trips TCC consent prompts (Desktop/Documents/Downloads, Photos, the
// Music/TV media libraries) attributed to whatever app spawned the CLI. Redacting paths before the
// prompt is built keeps the user's intent while removing the filesystem reference. The original
// transcript text is left untouched in the local store.

const LOCAL_PATH_REPLACEMENT = "[local file path]";

/** A path's leading segment: an absolute route under a real system root, or a `~`/`~user` home ref.
 *  The leading negative lookbehind requires the root to begin at a boundary (start of string,
 *  whitespace, quote, `=`, etc.) and never right after an alphanumeric/`.`/`-`/`_`. That keeps URL
 *  and host paths like `example.com/home/x` or `site.com/media/y` intact while still catching
 *  `/home`, `/media`, `/root` as real filesystem roots. App routes (`/api/...`, `/docs/...`) aren't
 *  listed, so they're never redacted regardless. */
const LOCAL_PATH_START =
  "(?<![A-Za-z0-9._-])(?:/(?:Users|Volumes|Network|private|var|tmp|home|opt|Applications|mnt|media|root|srv)(?=/)|~(?:[A-Za-z0-9._-]+)?/)";
// A run of path characters that also crosses shell-style backslash-escaped spaces (`My\ Docs`) so a
// path with escaped spaces stays whole. Unescaped whitespace still ends the run, so trailing prose
// isn't swallowed; bare unquoted spaced paths are handled by the quoted/extension rules instead.
const LOCAL_PATH_CHARS = "(?:\\\\ |[^\\s\\\\\"'`<>()[\\]{}])+";
// Extensions the with-extension rule recognizes. This is the only rule whose char class allows
// spaces, so it's what redacts spaced paths under a root — notably media-library bundles (Photos,
// Apple Music, TV, iMovie), whose default names contain a space, and spaced document names.
const LOCAL_PATH_EXTENSIONS = [
  "photoslibrary|musiclibrary|tvlibrary|imovielibrary", // media-library bundles
  "png|jpe?g|heic|gif|webp|svg|bmp|tiff?|ico|avif", // images
  "mov|mp4|m4v|mkv|avi|webm|wmv|mp3|m4a|aac|flac|aiff|wav", // audio/video
  "pdf|docx?|xlsx?|pptx?|pages|numbers|key|rtf|odt|ods|odp|epub|ipynb", // documents
  "txt|md|csv|tsv|jsonl?|ya?ml|xml|toml|ini|conf|cfg|env|log|sql|parquet", // text/data/config
  "ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|sh|zsh|bash", // code
  "zip|tar|gz|7z|rar|dmg|pkg|iso", // archives/disk images
  "pem|crt|cer|p12|pfx|db|sqlite", // certs/keys and local stores
].join("|");
const LOCAL_PATH_WITH_EXTENSION_RE = new RegExp(
  `${LOCAL_PATH_START}[^\\n"'\`<>]*?\\.(?:${LOCAL_PATH_EXTENSIONS})(?=\\b|[\\s"'\`<>()[\\]{}])`,
  "gi",
);
const LOCAL_FILE_URL_RE = /file:\/\/\/[^\s"'`<>()[\]{}]+/g;
/** A quoted string whose contents begin with a local path root. The closing quote is an
 *  unambiguous terminator, so a spaced path like "/Users/you/My Docs/report" is redacted whole. */
const LOCAL_QUOTED_PATH_RE = new RegExp(
  `(["'\`])${LOCAL_PATH_START}[^"'\`\\n]*\\1`,
  "g",
);
const LOCAL_POSIX_PATH_RE = new RegExp(
  `${LOCAL_PATH_START}${LOCAL_PATH_CHARS}`,
  "g",
);
const LOCAL_WINDOWS_PATH_RE =
  /\b(?:[A-Za-z]:\\|\\\\[^\\/\s"'`<>()[\]{}]+\\[^\\/\s"'`<>()[\]{}]+\\)[^\s"'`<>()[\]{}]+/g;

/** Redact local filesystem references (POSIX/Windows paths and `file://` URLs) from text bound for
 *  an LLM provider, replacing each with a neutral placeholder. Non-file absolute routes such as
 *  `/api/...` or `/docs/...` are left intact. */
export function sanitizeProviderText(text: string): string {
  return text
    .replace(LOCAL_FILE_URL_RE, LOCAL_PATH_REPLACEMENT)
    .replace(LOCAL_QUOTED_PATH_RE, LOCAL_PATH_REPLACEMENT)
    .replace(LOCAL_PATH_WITH_EXTENSION_RE, LOCAL_PATH_REPLACEMENT)
    .replace(LOCAL_POSIX_PATH_RE, LOCAL_PATH_REPLACEMENT)
    .replace(LOCAL_WINDOWS_PATH_RE, LOCAL_PATH_REPLACEMENT);
}

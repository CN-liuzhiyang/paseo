/**
 * The GitHub repository this build takes its releases and changelog from.
 *
 * Overridable at build time so a fork or a self-hosted build offers its own
 * updates instead of upstream's. Unset builds keep pointing at upstream.
 */
const SOURCE_REPO = process.env.EXPO_PUBLIC_PASEO_SOURCE_REPO || "getpaseo/paseo";

export const RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${SOURCE_REPO}/releases/download`;

/**
 * The whole URL is overridable, not just the repository: a fork cannot write
 * its releases into CHANGELOG.md without conflicting on every upstream sync,
 * so its notes live in a different file, on a different branch. Point this at
 * a moving ref — the sheet refetches on every open precisely to pick up
 * releases that shipped after this build.
 */
export const CHANGELOG_RAW_URL =
  process.env.EXPO_PUBLIC_PASEO_CHANGELOG_URL ||
  `https://raw.githubusercontent.com/${SOURCE_REPO}/main/CHANGELOG.md`;

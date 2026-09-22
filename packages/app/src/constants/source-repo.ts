/**
 * The GitHub repository this build takes its releases and changelog from.
 *
 * Overridable at build time so a fork or a self-hosted build offers its own
 * updates instead of upstream's. Unset builds keep pointing at upstream.
 */
const SOURCE_REPO = process.env.EXPO_PUBLIC_PASEO_SOURCE_REPO || "getpaseo/paseo";

export const RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${SOURCE_REPO}/releases/download`;

export const CHANGELOG_RAW_URL = `https://raw.githubusercontent.com/${SOURCE_REPO}/main/CHANGELOG.md`;

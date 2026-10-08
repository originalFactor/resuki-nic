import "server-only";

import { CONTRIBUTOR_CACHE_SECONDS, CONTRIBUTOR_REPO, GITHUB_API, GITHUB_TOKEN } from "./config";
import { kvGetJson, kvSetJson } from "./kv";

/**
 * Contributor lookups against the GitHub REST API.
 *
 * `GET /repos/{owner}/{repo}/contributors` is used because it needs no
 * authentication to read public repositories and matches "is this account in
 * the contributor list" exactly. Unauthenticated requests are limited to 60
 * per hour per IP, so results are cached and a token is strongly recommended
 * (GITHUB_TOKEN raises the budget to 5000/hour).
 */

interface GitHubContributor {
  login?: string;
  type?: string;
  contributions?: number;
}

const CONTRIBUTOR_PAGE_SIZE = 100;
/** Hard stop so a huge repository cannot make one request unbounded. */
const CONTRIBUTOR_MAX_PAGES = 10;

function contributorCacheKey(repo: string, login: string): string {
  return `gh:contrib:${repo.toLowerCase()}:${login.toLowerCase()}`;
}

async function githubFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "resuki-nic",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return fetch(url, { headers, cache: "no-store" });
}

export interface ContributorCheck {
  repo: string;
  login: string;
  isContributor: boolean;
  /** Where the answer came from, useful for the UI and for debugging. */
  source: "cache" | "github" | "unavailable";
  contributions?: number;
  detail?: string;
}

export async function isContributor(
  login: string,
  repo = CONTRIBUTOR_REPO,
): Promise<ContributorCheck> {
  const cached = await kvGetJson<ContributorCheck>(contributorCacheKey(repo, login));
  if (cached) {
    return { ...cached, source: "cache" };
  }

  const result: ContributorCheck = {
    repo,
    login,
    isContributor: false,
    source: "github",
  };

  for (let page = 1; page <= CONTRIBUTOR_MAX_PAGES; page += 1) {
    const url = `${GITHUB_API}/repos/${repo}/contributors?per_page=${CONTRIBUTOR_PAGE_SIZE}&page=${page}&anon=0`;
    let response: Response;
    try {
      response = await githubFetch(url);
    } catch (error) {
      return {
        repo,
        login,
        isContributor: false,
        source: "unavailable",
        detail: error instanceof Error ? error.message : "GitHub request failed",
      };
    }

    if (response.status === 204 || response.status === 404) {
      return {
        repo,
        login,
        isContributor: false,
        source: "github",
        detail: `repository ${repo} returned ${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        repo,
        login,
        isContributor: false,
        source: "unavailable",
        detail: `GitHub responded ${response.status}`,
      };
    }

    const body = (await response.json()) as GitHubContributor[];
    if (!Array.isArray(body) || body.length === 0) {
      break;
    }

    const match = body.find(
      (entry) => entry.login?.toLowerCase() === login.toLowerCase() && entry.type !== "Anonymous",
    );
    if (match) {
      result.isContributor = true;
      result.contributions = match.contributions ?? 0;
      break;
    }

    if (body.length < CONTRIBUTOR_PAGE_SIZE) {
      break;
    }
  }

  await kvSetJson(contributorCacheKey(repo, login), result, CONTRIBUTOR_CACHE_SECONDS);
  return result;
}

export interface GitHubProfile {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export async function fetchProfile(login: string): Promise<GitHubProfile | null> {
  let response: Response;
  try {
    response = await githubFetch(`${GITHUB_API}/users/${encodeURIComponent(login)}`);
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as {
    login?: string;
    name?: string | null;
    avatar_url?: string | null;
  };
  if (!body.login) {
    return null;
  }

  return {
    login: body.login,
    name: body.name ?? null,
    avatarUrl: body.avatar_url ?? null,
  };
}

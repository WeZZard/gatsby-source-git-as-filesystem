import gatsby from 'gatsby';
import git from 'simple-git';
import {SimpleGit} from 'simple-git';
import fastGlob from 'fast-glob';
import {FileSystemOptions, FileSystemNode} from 'gatsby-source-filesystem';
import fs from 'fs';
type CreateFileNode = (
  path: string,
  createNodeId: Function,
  pluginOptions: FileSystemOptions
) => Promise<FileSystemNode>
const {
  createFileNode,
}: {
  createFileNode: CreateFileNode,
} = require('gatsby-source-filesystem/create-file-node');
import gitUrlParse from 'git-url-parse';
import path from 'path';
import debug from 'debug';
const log = debug('gatsby-source-git-as-filesystem');

/**
 * Check is a remote url has already been cloned.
 * @param {string} remote
 * @param {string} repoPath
 * @return {boolean}
 */
async function isAlreadyCloned(remote: string, repoPath: string):
  Promise<boolean> {
  const existingRemote = await git(repoPath).listRemote(['--get-url']);
  return existingRemote.trim() == remote.trim();
}

/**
 * Getting the branch of a repo
 * @param {string} repo
 * @param {string} branch
 * @return {string}
 */
async function getTargetBranch(branch: string):
  Promise<string> {
  return `origin/${branch}`;
}

/**
 * Getting a cloned repo
 * @param {string} cachePath
 * @param {string} remote
 * @param {string} branch
 * @return {string}
 */
async function getRepo(cachePath: string, remote: string, branch: string):
  Promise<SimpleGit> {
  // If the directory doesn't exist or is empty, clone. This will be the case if
  // our config has changed because Gatsby trashes the cache dir automatically
  // in that case.
  if (!fs.existsSync(cachePath) || fs.readdirSync(cachePath).length === 0) {
    const opts = [`--depth`, `1`];
    if (typeof branch == `string`) {
      opts.push(`--branch`, branch);
    }
    await git().clone(remote, cachePath, opts);
    return git(cachePath);
  } else if (await isAlreadyCloned(remote, cachePath)) {
    const repo = await git(cachePath);
    const target = await getTargetBranch(branch);
    // Refresh our shallow clone with the latest commit.
    await repo
      .fetch([`--depth`, `1`])
      .then(() => repo.reset([`--hard`, target]));
    return repo;
  } else {
    throw new Error(`Can't clone to target destination: ${cachePath}`);
  }
}

interface PluginOptions {
  name: string,
  remote: string,
  branch: string,
  patterns?: string,
  local?: string,
}

/**
 * Source nodes
 * @param {gatsby.NodePluginArgs} args
 * @param {PluginOptions} options
 */
export async function sourceNodes(
  {
    actions: {createNode},
    store,
    createNodeId,
    createContentDigest,
    reporter,
  }: gatsby.NodePluginArgs,
  {name, remote, branch, patterns = `**`, local} : PluginOptions,
): Promise<void> {
  log('begin');

  const programDir = store.getState().program.directory;
  const localPath = local || path.join(
    programDir,
    `.cache`,
    `gatsby-source-git-as-filesystem`,
    name,
  );
  const parsedRemote = gitUrlParse(remote);

  let repo;
  try {
    repo = await getRepo(localPath, remote, branch);
    log('get repo');
  } catch (e) {
    log('error happened while getting repo');
    reporter.error(new Error(`${e}`));
    return;
  }

  parsedRemote.git_suffix = false;
  delete parsedRemote.git_suffix;
  const ref = await repo.raw(['rev-parse', '--abbrev-ref', 'HEAD']);
  parsedRemote.ref = ref.trim();

  const repoFiles = await fastGlob(patterns, {
    cwd: localPath,
    absolute: true,
  });

  const remoteId = createNodeId(`git-remote-${name}`);

  const node: gatsby.NodeInput & gitUrlParse.GitUrl = {
    id: remoteId,
    sourceInstanceName: name,
    parent: null,
    children: [],
    internal: {
      type: `GitRemote`,
      content: JSON.stringify(parsedRemote),
      contentDigest: createContentDigest(parsedRemote),
    },
    ...parsedRemote,
  };

  // Create a single graph node for this git remote.
  // Filenodes sourced from it will get a field pointing back to it.
  await createNode(node);

  log(`create node for git remote at url: ${remote}`);

  for (const filePath of repoFiles) {
    const fileNode = await createFileNode(filePath, createNodeId, {
      name: name,
      path: localPath,
    });
    log(`create file node for file at path: ${filePath}`);
    // Add a link to the git remote node
    fileNode.gitRemote___NODE = remoteId;
    // Then create the node, as if it were created by the gatsby-source
    // filesystem plugin.
    await createNode(fileNode, {
      name: `gatsby-source-filesystem`,
    });
    log(`create wrapping node for file at path: ${filePath}`);
  }
};

exports.onCreateNode;

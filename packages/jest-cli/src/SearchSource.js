/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

'use strict';

import type {HasteContext} from 'types/HasteMap';
import type {Path} from 'types/Config';
import type {ResolveModuleConfig} from '../../jest-resolve/src';

const DependencyResolver = require('jest-resolve-dependencies');

const chalk = require('chalk');
const changedFiles = require('jest-changed-files');
const fileExists = require('jest-file-exists');
const path = require('path');
const {
  escapePathForRegex,
  replacePathSepForRegex,
} = require('jest-util');

type SearchSourceConfig = {
  testPathDirs: Array<Path>,
  testRegex: RegExp,
  testPathIgnorePatterns: Array<RegExp>,
};

type SearchResult = {
  noSCM?: boolean,
  paths: Array<Path>,
  stats?: {[key: string]: number},
  total?: number,
};

type StrOrRegExpPattern = RegExp | string;

type PatternInfo = {
  input?: string,
  lastCommit?: boolean,
  onlyChanged?: boolean,
  shouldTreatInputAsPattern?: boolean,
  testPathPattern?: string,
  watch?: boolean,
};

type Options = {
  lastCommit?: boolean,
};

const git = changedFiles.git;
const hg = changedFiles.hg;

const determineSCM = path => Promise.all([
  git.isGitRepository(path),
  hg.isHGRepository(path),
]);
const pathToRegex = p => replacePathSepForRegex(p);
const pluralize = (
  word: string,
  count: number,
  ending: string,
) => `${count} ${word}${count === 1 ? '' : ending}`;

class SearchSource {
  _hasteContext: HasteContext;
  _config: SearchSourceConfig;
  _options: ResolveModuleConfig;
  _testPathDirPattern: RegExp;
  _testRegex: RegExp;
  _testIgnorePattern: ?RegExp;
  _testPathCases: {
    testPathDirs: (path: Path) => boolean,
    testRegex: (path: Path) => boolean,
    testPathIgnorePatterns: (path: Path) => boolean,
  };

  constructor(
    hasteMap: HasteContext,
    config: SearchSourceConfig,
    options?: ResolveModuleConfig,
  ) {
    this._hasteContext = hasteMap;
    this._config = config;
    this._options = options || {};

    this._testPathDirPattern =
      new RegExp(config.testPathDirs.map(
        dir => escapePathForRegex(dir),
      ).join('|'));

    this._testRegex = new RegExp(pathToRegex(config.testRegex));
    const ignorePattern = config.testPathIgnorePatterns;
    this._testIgnorePattern =
      ignorePattern.length ? new RegExp(ignorePattern.join('|')) : null;

    this._testPathCases = {
      testPathDirs: path => this._testPathDirPattern.test(path),
      testRegex: path => this._testRegex.test(path),
      testPathIgnorePatterns: path => (
        !this._testIgnorePattern ||
        !this._testIgnorePattern.test(path)
      ),
    };
  }

  _filterTestPathsWithStats(
    allPaths: Array<Path>,
    testPathPattern?: StrOrRegExpPattern,
  ): SearchResult {
    const data = {
      paths: [],
      stats: {},
      total: allPaths.length,
    };

    const testCases = Object.assign({}, this._testPathCases);
    if (testPathPattern) {
      const regex = new RegExp(testPathPattern);
      testCases.testPathPattern = path => regex.test(path);
    }

    data.paths = allPaths.filter(path => {
      return Object.keys(testCases).reduce((flag, key) => {
        if (testCases[key](path)) {
          data.stats[key] = ++data.stats[key] || 1;
          return flag && true;
        }
        data.stats[key] = data.stats[key] || 0;
        return false;
      }, true);
    });

    return data;
  }

  _getAllTestPaths(
    testPathPattern: StrOrRegExpPattern,
  ): SearchResult {
    return this._filterTestPathsWithStats(
      this._hasteContext.hasteFS.getAllFiles(),
      testPathPattern,
    );
  }

  isTestFilePath(path: Path): boolean {
    return Object.keys(this._testPathCases).every(key => (
      this._testPathCases[key](path)
    ));
  }

  findMatchingTests(
    testPathPattern: StrOrRegExpPattern,
  ): SearchResult {
    if (testPathPattern && !(testPathPattern instanceof RegExp)) {
      const maybeFile = path.resolve(process.cwd(), testPathPattern);
      if (fileExists(maybeFile, this._hasteContext.hasteFS)) {
        return this._filterTestPathsWithStats([maybeFile]);
      }
    }

    return this._getAllTestPaths(testPathPattern);
  }

  findRelatedTests(allPaths: Set<Path>): SearchResult {
    const dependencyResolver = new DependencyResolver(
      this._hasteContext.resolver,
      this._hasteContext.hasteFS,
    );
    return {
      paths: dependencyResolver.resolveInverse(
        allPaths,
        this.isTestFilePath.bind(this),
        {
          skipNodeResolution: this._options.skipNodeResolution,
        },
      ),
    };
  }

  findChangedTests(options: Options): Promise<SearchResult> {
    return Promise.all(this._config.testPathDirs.map(determineSCM))
      .then(repos => {
        if (!repos.every(([gitRepo, hgRepo]) => gitRepo || hgRepo)) {
          return {
            noSCM: true,
            paths: [],
          };
        }
        return Promise.all(Array.from(repos).map(([gitRepo, hgRepo]) => {
          return gitRepo
            ? git.findChangedFiles(gitRepo, options)
            : hg.findChangedFiles(hgRepo, options);
        })).then(changedPathSets => this.findRelatedTests(
          new Set(Array.prototype.concat.apply([], changedPathSets)),
        ));
      });
  }

  static getTestSummary(patternInfo: PatternInfo) {
    const testPathPattern = getTestPathPattern(patternInfo);
    const testInfo = patternInfo.onlyChanged
      ? ' related to changed files'
      : patternInfo.input !== ''
        ? ' matching ' + chalk.bold(testPathPattern)
        : '';

    return 'Ran all tests' + testInfo + '.';
  }

  getNoTestsFoundMessage(
    patternInfo: PatternInfo,
    config: {[key: string]: string},
    data: SearchResult,
  ): string {
    if (patternInfo.onlyChanged) {
      return (
        chalk.bold(
          'No tests found related to files changed since last commit.\n',
        ) +
        chalk.dim(
          patternInfo.watch ?
            'Press `a` to run all tests, or run Jest with `--watchAll`.' :
            'Run Jest without `-o` to run all tests.',
        )
      );
    }

    const testPathPattern = getTestPathPattern(patternInfo);
    const stats = data.stats || {};
    const statsMessage = Object.keys(stats).map(key => {
      const value = key === 'testPathPattern' ? testPathPattern : config[key];
      if (value) {
        const matches = pluralize('match', stats[key], 'es');
        return `  ${key}: ${chalk.yellow(value)} - ${matches}`;
      }
      return null;
    }).filter(line => line).join('\n');

    return (
      chalk.bold('No tests found') + '\n' +
      (data.total
        ? `  ${pluralize('file', data.total || 0, 's')} checked.\n` +
          statsMessage
        : `No files found in ${config.rootDir}.\n` +
          `Make sure Jest's configuration does not exclude this directory.\n` +
          `To set up Jest, make sure a package.json file exists.\n` +
          `Jest API Documentation: facebook.github.io/jest/docs/api.html`
      )
    );
  }

  getTestPaths(patternInfo: PatternInfo): Promise<SearchResult> {
    if (patternInfo.onlyChanged) {
      return this.findChangedTests({lastCommit: patternInfo.lastCommit});
    } else if (patternInfo.testPathPattern != null) {
      return Promise.resolve(
        this.findMatchingTests(patternInfo.testPathPattern),
      );
    } else {
      return Promise.resolve({paths: []});
    }
  }

}

const getTestPathPattern = (patternInfo: PatternInfo) => {
  const pattern = patternInfo.testPathPattern;
  const input = patternInfo.input;
  const formattedPattern = `/${pattern || ''}/`;
  const formattedInput = patternInfo.shouldTreatInputAsPattern
    ? `/${input || ''}/`
    : `"${input || ''}"`;
  return (input === pattern) ? formattedInput : formattedPattern;
};

module.exports = SearchSource;

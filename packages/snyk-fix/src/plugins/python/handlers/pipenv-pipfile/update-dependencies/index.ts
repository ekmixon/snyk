import { spawn, SpawnOptions } from 'child_process';
import * as pathLib from 'path';
import * as debugLib from 'debug';

import Bottleneck from 'bottleneck';

import { PluginFixResponse } from '../../../../types';
import {
  DependencyPins,
  EntityToFix,
  FixChangesSummary,
  FixOptions,
} from '../../../../../types';
import { getRequiredData } from '../../get-required-data';
import { NoFixesCouldBeAppliedError } from '../../../../../lib/errors/no-fixes-applied';
import { standardizePackageName } from '../../pip-requirements/update-dependencies/standardize-package-name';
import { CommandFailedError } from '../../../../../lib/errors/command-failed-to-run-error';
import { execute, ExecuteResponse } from '../../sub-process';

const debug = debugLib('snyk-fix:python:Pipfile');

interface PipEnvConfig {
  pythonVersion?: '2' | '3';
  pythonCommand?: string; // use the provided Python interpreter
}

const limiter = new Bottleneck({
  maxConcurrent: 4,
});

const runPipAddLimitedConcurrency = limiter.wrap(runPipEnvInstall);

// https://pipenv.pypa.io/en/latest/advanced/#changing-default-python-versions
function getPythonversionArgs(config: PipEnvConfig): string | void {
  if (config.pythonCommand) {
    return '--python'; // Performs the installation in a virtualenv using the provided Python interpreter.
  }
  if (config.pythonVersion === '2') {
    return '--two'; // Performs the installation in a virtualenv using the system python3 link.
  }
  if (config.pythonVersion === '3') {
    return '--three'; // Performs the installation in a virtualenv using the system python2 link.
  }
}

async function runPipEnvInstall(
  projectPath: string,
  requirements: string[],
  config: PipEnvConfig,
): Promise<ExecuteResponse> {
  const args = ['install', ...requirements];

  const pythonVersionArg = getPythonversionArgs(config);
  if (pythonVersionArg) {
    args.push(pythonVersionArg);
  }

  let res: ExecuteResponse;

  try {
    res = await execute('pipenv', args, { cwd: projectPath });
  } catch (e) {
    debug('Execute failed with', e);
    res = e;
  }

  return res;
}

export async function updateDependencies(
  entity: EntityToFix,
  options: FixOptions,
): Promise<PluginFixResponse> {
  const handlerResult: PluginFixResponse = {
    succeeded: [],
    failed: [],
    skipped: [],
  };
  try {
    const { remediation, targetFile } = getRequiredData(entity);
    const { dir } = pathLib.parse(
      pathLib.resolve(entity.workspace.path, targetFile),
    );
    // TODO: for better support we need to:
    // 1. parse the manifest and extract original requirements, version spec etc
    // 2. swap out only the version and retain original spec
    // 3. re-lock the lockfile
    // Currently this is not possible as there is no Pipfile parser that would do this.
    const upgrades = generateUpgrades(remediation.pin);
    if (!options.dryRun) {
      const res = await runPipAddLimitedConcurrency(
        dir,
        upgrades,
        {}, // TODO: get the CLI options
      );
      console.log(res);
      if (res.exitCode !== 0) {
        const pipenvError = getPipenvError(res.stderr);
        debug(
          `Failed to fix ${entity.scanResult.identity.targetFile}.\nERROR: ${res.stderr}`,
        );
        handlerResult.failed.push({
          original: entity,
          error: pipenvError,
          tip: `Try running \`${res.command}\``,
        });
        return handlerResult;
      }
    }
    const changes = generateSuccessfulChanges(remediation.pin);
    handlerResult.succeeded.push({ original: entity, changes });
  } catch (error) {
    debug(
      `Failed to fix ${entity.scanResult.identity.targetFile}.\nERROR: ${error}`,
    );
    handlerResult.failed.push({
      original: entity,
      error,
    });
  }
  return handlerResult;
}

function generateSuccessfulChanges(pins: DependencyPins): FixChangesSummary[] {
  const changes: FixChangesSummary[] = [];
  for (const pkgAtVersion of Object.keys(pins)) {
    const pin = pins[pkgAtVersion];
    const updatedMessage = pin.isTransitive ? 'Pinned' : 'Upgraded';
    const newVersion = pin.upgradeTo.split('@')[1];
    const [pkgName, version] = pkgAtVersion.split('@');

    changes.push({
      success: true,
      userMessage: `${updatedMessage} ${pkgName} from ${version} to ${newVersion}`,
      issueIds: pin.vulns,
      from: pkgAtVersion,
      to: `${pkgName}@${newVersion}`,
    });
  }
  return changes;
}

function generateUpgrades(pins: DependencyPins): string[] {
  const upgrades: string[] = [];
  for (const pkgAtVersion of Object.keys(pins)) {
    const pin = pins[pkgAtVersion];
    const newVersion = pin.upgradeTo.split('@')[1];
    const [pkgName] = pkgAtVersion.split('@');
    upgrades.push(`${standardizePackageName(pkgName)}>=${newVersion}`);
  }
  return upgrades;
}

function getPipenvError(stderr: string) {
  const incompatibleDeps =
    'There are incompatible versions in the resolved dependencies';
  const lockingFailed = 'Locking Failed';
  if (stderr.includes(incompatibleDeps)) {
    return new CommandFailedError(incompatibleDeps);
  }
  if (stderr.includes(lockingFailed)) {
    return new CommandFailedError(lockingFailed);
  }
  return new NoFixesCouldBeAppliedError();
}
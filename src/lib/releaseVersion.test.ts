import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './constants';
import pkg from '../../package.json';
import lock from '../../package-lock.json';
import tauri from '../../src-tauri/tauri.conf.json';
import cargoManifest from '../../src-tauri/Cargo.toml?raw';
import cargoLockfile from '../../src-tauri/Cargo.lock?raw';

describe('release version consistency', () => {
  it('uses the same version in the UI, npm manifests, Tauri and Rust', () => {
    const cargo = cargoManifest.match(/^version = "([^"]+)"/m)?.[1];
    const cargoLock = cargoLockfile.match(/name = "xdocuments"\r?\nversion = "([^"]+)"/)?.[1];
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (const version of [pkg.version, lock.version, lock.packages[''].version, tauri.version, cargo, cargoLock]) {
      expect(version).toBe(APP_VERSION);
    }
  });
});

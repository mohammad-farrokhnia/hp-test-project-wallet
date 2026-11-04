import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { InternalApiKeyGuard } from './internal-api-key.guard';

/** Path prefixes that must sit behind `InternalApiKeyGuard`. */
const INTERNAL_PREFIXES = ['internal', 'reconciliation'];

/**
 * @function unguardedInternalControllers
 * @description Lists controllers under `/internal` or `/reconciliation` without `@InternalOnly()` at class level.
 * @param modules - the app's `ModulesContainer`
 * @returns the controller names, sorted
 */
export function unguardedInternalControllers(
  modules: ModulesContainer,
): string[] {
  const found: string[] = [];
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype;
      if (!ctrl) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      const first = path.replace(/^\/+/, '').split('/')[0];
      if (!INTERNAL_PREFIXES.includes(first)) continue;
      const guards = (Reflect.getMetadata(GUARDS_METADATA, ctrl) ??
        []) as unknown[];
      if (!guards.includes(InternalApiKeyGuard)) found.push(ctrl.name);
    }
  }
  return found.sort();
}

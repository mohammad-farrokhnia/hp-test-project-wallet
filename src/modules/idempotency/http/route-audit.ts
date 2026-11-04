import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { FINANCIAL_POST, IDEMPOTENCY_EXEMPT } from './idempotency-key';

/**
 * @function unmarkedPostRoutes
 * @description Lists every POST route that is neither `@FinancialPost()` nor `@IdempotencyExempt()`.
 * @param modules - the app's `ModulesContainer`
 * @returns `POST /path` for each unmarked route, sorted
 */
export function unmarkedPostRoutes(modules: ModulesContainer): string[] {
  const found: string[] = [];
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!ctrl) continue;
      const base = Reflect.getMetadata(PATH_METADATA, ctrl) as string;
      const classExempt = Reflect.hasMetadata(IDEMPOTENCY_EXEMPT, ctrl);
      const proto = ctrl.prototype as Record<string, unknown>;

      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (
          Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod.POST
        ) {
          continue;
        }
        const marked =
          classExempt ||
          Reflect.hasMetadata(FINANCIAL_POST, handler) ||
          Reflect.hasMetadata(IDEMPOTENCY_EXEMPT, handler);
        if (marked) continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
        found.push(`POST ${joinPath(base, path)}`);
      }
    }
  }
  return found.sort();
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '')
    .join('/');
  return `/${joined}`;
}

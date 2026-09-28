import { TASK_KEY_PATTERN } from './schemas/common';

/** ERP + 125 -> "ERP-125". */
export function formatTaskKey(projectKey: string, number: number): string {
  return projectKey + '-' + number;
}

export interface ParsedTaskKey {
  projectKey: string;
  number: number;
}

export function parseTaskKey(value: string): ParsedTaskKey | null {
  const trimmed = value.trim().toUpperCase();
  if (!TASK_KEY_PATTERN.test(trimmed)) return null;
  const separator = trimmed.lastIndexOf('-');
  const projectKey = trimmed.slice(0, separator);
  const number = Number.parseInt(trimmed.slice(separator + 1), 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { projectKey, number };
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

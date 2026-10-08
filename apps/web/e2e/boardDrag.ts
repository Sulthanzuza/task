import type { Locator, Page } from '@playwright/test';

/**
 * Dragging a board card, shared by the board specs and the confirmation specs.
 *
 * Here rather than in one spec file because two specs now drag cards, and a
 * drag that works is fiddly enough that a second copy of it would drift.
 */

/** Drags a card onto a column, in small steps so dnd-kit registers the movement. */
export async function dragCardTo(page: Page, card: Locator, column: Locator): Promise<void> {
  // The board scrolls sideways, so a target column may be off-screen. Measuring
  // without bringing it into view would drag to a coordinate nobody can reach.
  await column.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await column.boundingBox();
  if (!from || !to) throw new Error('Could not measure the card or the column');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // dnd-kit needs the pointer to travel past its activation distance, and a
  // single jump can be missed entirely.
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 90, { steps: 12 });
  await page.mouse.move(to.x + to.width / 2, to.y + 100, { steps: 4 });
  await page.mouse.up();
}

export const column = (page: Page, status: string): Locator =>
  page.locator('[data-status="' + status + '"]');

export const card = (page: Page, key: string): Locator =>
  page.locator('[data-task-key="' + key + '"]').first();

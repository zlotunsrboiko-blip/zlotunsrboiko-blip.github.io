ALTER TABLE categories ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'account' CHECK(item_kind IN ('account','code'));
UPDATE categories
SET item_kind = COALESCE(
  (SELECT kind FROM inventory WHERE inventory.category_id = categories.id ORDER BY created_at, id LIMIT 1),
  'account'
);
UPDATE inventory
SET status = 'blocked', updated_at = datetime('now')
WHERE status = 'available'
  AND kind <> (SELECT item_kind FROM categories WHERE categories.id = inventory.category_id);

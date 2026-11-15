-- Disable the old dedicated fixture accounts without deleting wallets or audit history.
UPDATE retailers SET status='closed', credentials_changed_at=clock_timestamp()
WHERE retailer_slug='npay-demo-retailer' AND status <> 'closed';
UPDATE retailer_sessions SET revoked_at=NOW()
WHERE revoked_at IS NULL AND retailer_id IN (
  SELECT id FROM retailers WHERE retailer_slug='npay-demo-retailer'
);
UPDATE distributors SET status='closed', credentials_changed_at=clock_timestamp()
WHERE distributor_slug='npay-demo-distributor' AND status <> 'closed';
UPDATE recharge_plans SET is_active=false
WHERE code LIKE 'demo-%' AND is_active;

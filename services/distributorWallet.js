// Money calculations stay in PostgreSQL NUMERIC, never JavaScript floating point.
export async function commissionSnapshot(client, retailerId, operatorId) {
  const result = await client.query(
    `SELECT owner.distributor_id,
      retailer_commission_rate(owner.id, $2) AS retailer_rate,
      CASE WHEN allocation.is_active THEN allocation.rate ELSE 0 END AS distributor_rate,
      CASE WHEN allocation.is_active THEN GREATEST(allocation.rate - retailer_commission_rate(owner.id, $2), 0) ELSE 0 END AS margin_rate
    FROM retailers owner LEFT JOIN distributor_commission_slabs allocation
      ON allocation.distributor_id = owner.distributor_id AND allocation.operator_id = $2
    WHERE owner.id = $1`,
    [retailerId, operatorId],
  );
  return result.rows[0];
}

export async function ensureDistributorWallet(client, distributorId) {
  await client.query(
    "INSERT INTO distributor_wallets (distributor_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [distributorId],
  );
}

export async function creditDistributorCommission(client, payment) {
  if (
    !payment.distributor_id ||
    Number(payment.distributor_commission_amount) <= 0
  )
    return;
  await ensureDistributorWallet(client, payment.distributor_id);
  await client.query(
    `INSERT INTO distributor_wallet_entries
    (distributor_id, transaction_id, kind, amount) VALUES ($1,$2,'commission',$3)`,
    [payment.distributor_id, payment.id, payment.distributor_commission_amount],
  );
}

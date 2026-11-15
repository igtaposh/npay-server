-- An operator identifies one company and service pair in the existing catalog.
CREATE TABLE IF NOT EXISTS distributor_commission_slabs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id UUID NOT NULL REFERENCES distributors(id),
    operator_id UUID NOT NULL REFERENCES service_operators(id),
    rate NUMERIC(7,4) NOT NULL CHECK (rate BETWEEN 0 AND 100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (distributor_id, operator_id)
);

-- Legacy rates continue to work until an explicit distributor allocation exists.
-- An inactive allocation pays zero; absent retailer allocations under the new
-- hierarchy also pay zero. Existing transaction rate snapshots are untouched.
CREATE OR REPLACE FUNCTION retailer_commission_rate(retailer UUID, operator UUID)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN d.id IS NOT NULL THEN
        CASE WHEN d.is_active AND r.is_active THEN LEAST(r.rate, d.rate) ELSE 0 END
        WHEN r.id IS NOT NULL THEN CASE WHEN r.is_active THEN r.rate ELSE 0 END
        ELSE COALESCE(a.rate, 0) END
    FROM retailers owner
    LEFT JOIN distributor_commission_slabs d ON d.distributor_id = owner.distributor_id AND d.operator_id = operator
    LEFT JOIN retailer_commission_slabs r ON r.retailer_id = owner.id AND r.operator_id = operator
    LEFT JOIN commision_slab_by_admin a ON a.operator_id = operator AND a.is_active
    WHERE owner.id = retailer
$$;

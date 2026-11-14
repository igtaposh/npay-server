CREATE TABLE IF NOT EXISTS service_operators (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    service VARCHAR(20) NOT NULL CHECK (service IN ('prepaid', 'dth', 'google-play')),
    logo_url TEXT,
    account_label VARCHAR(100),
    account_digits SMALLINT CHECK (account_digits BETWEEN 1 AND 30),
    min_amount NUMERIC(14,2) NOT NULL DEFAULT 1 CHECK (min_amount > 0),
    max_amount NUMERIC(14,2) NOT NULL DEFAULT 100000 CHECK (max_amount >= min_amount),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, service)
);

CREATE TABLE IF NOT EXISTS telecom_circles (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recharge_plans (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES service_operators(id),
    circle_id UUID REFERENCES telecom_circles(id),
    code VARCHAR(100) NOT NULL,
    name VARCHAR(200) NOT NULL,
    category VARCHAR(20) NOT NULL CHECK (category IN
        ('popular', 'unlimited', 'data', 'talktime', 'isd', 'topup', 'dth', 'gift-code')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    data_allowance VARCHAR(100),
    validity VARCHAR(100),
    channels VARCHAR(100),
    description TEXT,
    tag VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE NULLS NOT DISTINCT (operator_id, circle_id, code),
    UNIQUE (id, operator_id)
);
CREATE INDEX IF NOT EXISTS recharge_plans_catalog_idx ON recharge_plans (operator_id, circle_id, category);

-- Preserve the original table spelling and legacy columns for existing databases.
-- question/answer were FAQ placeholders; controllers should use the columns below.
CREATE TABLE IF NOT EXISTS commision_slab_by_admin (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    question VARCHAR(200),
    answer TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE commision_slab_by_admin ALTER COLUMN question DROP NOT NULL;
ALTER TABLE commision_slab_by_admin ALTER COLUMN answer DROP NOT NULL;
ALTER TABLE commision_slab_by_admin ADD COLUMN IF NOT EXISTS operator_id UUID REFERENCES service_operators(id);
ALTER TABLE commision_slab_by_admin ADD COLUMN IF NOT EXISTS rate NUMERIC(7,4)
    CHECK (rate BETWEEN 0 AND 100);
ALTER TABLE commision_slab_by_admin ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS commision_slab_operator_unique ON commision_slab_by_admin (operator_id);
-- NOT VALID preserves any old placeholder rows; new writes must specify real rates.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = 'commision_slab_by_admin'::regclass AND conname = 'commission_operator_rate_required') THEN
        ALTER TABLE commision_slab_by_admin ADD CONSTRAINT commission_operator_rate_required
            CHECK (operator_id IS NOT NULL AND rate IS NOT NULL) NOT VALID;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS retailer_commission_slabs (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    retailer_id UUID NOT NULL REFERENCES retailers(id),
    operator_id UUID NOT NULL REFERENCES service_operators(id),
    rate NUMERIC(7,4) NOT NULL CHECK (rate BETWEEN 0 AND 100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (retailer_id, operator_id)
);

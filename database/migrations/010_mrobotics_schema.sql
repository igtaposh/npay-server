ALTER TABLE recharge_plans ADD COLUMN IF NOT EXISTS mrobotics_is_stv BOOLEAN;
-- Numeric merchant order IDs match the documented request examples. Never reset this sequence.
CREATE TABLE IF NOT EXISTS recharge_submissions (
    transaction_id UUID PRIMARY KEY REFERENCES transactions(id),
    provider VARCHAR(30) NOT NULL DEFAULT 'mrobotics' CHECK (provider = 'mrobotics'),
    order_id BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 100000000000000) UNIQUE,
    request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
    attempted_at TIMESTAMPTZ,
    provider_id VARCHAR(200),
    operator_reference VARCHAR(200),
    provider_status VARCHAR(40) NOT NULL DEFAULT 'not_submitted',
    response_payload JSONB,
    last_checked_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retailer_wallets (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    retailer_id UUID NOT NULL UNIQUE REFERENCES retailers(id),
    currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, retailer_id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    retailer_id UUID NOT NULL REFERENCES retailers(id),
    wallet_id UUID NOT NULL,
    idempotency_key VARCHAR(150) NOT NULL CHECK (btrim(idempotency_key) <> ''),
    service VARCHAR(20) NOT NULL CHECK (service IN ('prepaid', 'dth', 'google-play', 'wallet')),
    category VARCHAR(20) GENERATED ALWAYS AS
        (CASE WHEN service = 'wallet' THEN 'wallet'
              WHEN service = 'google-play' THEN 'google-play' ELSE 'recharge' END) STORED,
    operator_id UUID,
    circle_id UUID REFERENCES telecom_circles(id),
    plan_id UUID,
    recipient VARCHAR(30),
    recipient_email VARCHAR(255),
    customer_name VARCHAR(254),
    title VARCHAR(200) NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    plan_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(plan_snapshot) = 'object'),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    status VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Successful', 'Failed')),
    commission_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (commission_rate BETWEEN 0 AND 100),
    commission_amount NUMERIC(14,2) GENERATED ALWAYS AS (round(amount * commission_rate / 100, 2)) STORED,
    provider VARCHAR(100),
    provider_reference VARCHAR(200),
    operator_reference VARCHAR(200),
    payment_method VARCHAR(30),
    failure_code VARCHAR(100),
    failure_reason TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (wallet_id, retailer_id) REFERENCES retailer_wallets(id, retailer_id),
    FOREIGN KEY (operator_id, service) REFERENCES service_operators(id, service),
    FOREIGN KEY (plan_id, operator_id) REFERENCES recharge_plans(id, operator_id),
    UNIQUE (retailer_id, idempotency_key),
    UNIQUE (id, wallet_id, retailer_id),
    UNIQUE (id, service),
    CHECK ((service = 'wallet' AND operator_id IS NULL AND plan_id IS NULL AND commission_rate = 0)
        OR (service <> 'wallet' AND operator_id IS NOT NULL)),
    CHECK (service <> 'prepaid' OR (recipient IS NOT NULL AND recipient ~ '^[6-9][0-9]{9}$' AND circle_id IS NOT NULL)),
    CHECK (service <> 'dth' OR (recipient IS NOT NULL AND recipient ~ '^[0-9]{10,11}$' AND amount <= 25000 AND amount = trunc(amount))),
    CHECK (service <> 'google-play' OR (amount BETWEEN 100 AND 10000 AND amount = trunc(amount))),
    CHECK (service <> 'wallet' OR amount BETWEEN 1 AND 100000)
);
CREATE INDEX IF NOT EXISTS transactions_history_idx ON transactions (retailer_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (retailer_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_pending_idx ON transactions (created_at) WHERE status = 'Pending';
CREATE INDEX IF NOT EXISTS transactions_operator_idx ON transactions (operator_id);
CREATE INDEX IF NOT EXISTS transactions_plan_idx ON transactions (plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_provider_reference_unique
    ON transactions (provider, provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_entries (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL,
    retailer_id UUID NOT NULL,
    transaction_id UUID NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('topup', 'recharge', 'refund', 'commission')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    direction VARCHAR(6) GENERATED ALWAYS AS
        (CASE WHEN kind = 'recharge' THEN 'debit' ELSE 'credit' END) STORED,
    balance_after NUMERIC(14,2) NOT NULL CHECK (balance_after >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (wallet_id, retailer_id) REFERENCES retailer_wallets(id, retailer_id),
    FOREIGN KEY (transaction_id, wallet_id, retailer_id) REFERENCES transactions(id, wallet_id, retailer_id),
    UNIQUE (transaction_id, kind)
);
CREATE INDEX IF NOT EXISTS wallet_entries_wallet_idx ON wallet_entries (wallet_id, created_at DESC);

-- Inserts post the balance atomically. Controllers must not also update balance.
CREATE OR REPLACE FUNCTION post_wallet_entry() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    payment transactions%ROWTYPE;
BEGIN
    SELECT * INTO STRICT payment FROM transactions WHERE id = NEW.transaction_id FOR UPDATE;
    -- Check before updating balance: ON CONFLICT DO NOTHING must never credit twice.
    IF EXISTS (SELECT 1 FROM wallet_entries WHERE transaction_id = NEW.transaction_id AND kind = NEW.kind) THEN
        RAISE EXCEPTION 'Entry already posted for transaction and kind' USING ERRCODE = '23505';
    END IF;
    IF NEW.kind = 'topup' AND (payment.service <> 'wallet' OR payment.status <> 'Successful') THEN
        RAISE EXCEPTION 'Top-up requires a successful wallet transaction';
    ELSIF NEW.kind = 'recharge' AND (payment.service = 'wallet' OR payment.status = 'Failed') THEN
        RAISE EXCEPTION 'Debit requires a pending or successful recharge';
    ELSIF NEW.kind = 'refund' AND (payment.service = 'wallet' OR payment.status <> 'Failed'
        OR NOT EXISTS (SELECT 1 FROM wallet_entries WHERE transaction_id = payment.id AND kind = 'recharge')) THEN
        RAISE EXCEPTION 'Refund requires a failed, previously debited recharge';
    ELSIF NEW.kind = 'commission' AND (payment.service = 'wallet' OR payment.status <> 'Successful'
        OR NOT EXISTS (SELECT 1 FROM wallet_entries WHERE transaction_id = payment.id AND kind = 'recharge')) THEN
        RAISE EXCEPTION 'Commission requires a successful, debited recharge';
    END IF;
    IF NEW.amount <> (CASE WHEN NEW.kind = 'commission' THEN payment.commission_amount ELSE payment.amount END) THEN
        RAISE EXCEPTION 'Entry amount does not match transaction';
    END IF;
    UPDATE retailer_wallets
        SET balance = balance + CASE WHEN NEW.kind = 'recharge' THEN -NEW.amount ELSE NEW.amount END,
            updated_at = NOW()
        WHERE id = NEW.wallet_id AND retailer_id = NEW.retailer_id
        RETURNING balance INTO NEW.balance_after;
    IF NOT FOUND THEN RAISE EXCEPTION 'Wallet does not belong to retailer'; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wallet_entries_post ON wallet_entries;
CREATE TRIGGER wallet_entries_post BEFORE INSERT ON wallet_entries FOR EACH ROW EXECUTE FUNCTION post_wallet_entry();

CREATE OR REPLACE FUNCTION reject_wallet_entry_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Wallet entries are immutable; post a refund instead';
END $$;
DROP TRIGGER IF EXISTS wallet_entries_immutable ON wallet_entries;
CREATE TRIGGER wallet_entries_immutable BEFORE UPDATE OR DELETE ON wallet_entries
    FOR EACH ROW EXECUTE FUNCTION reject_wallet_entry_change();

CREATE TABLE IF NOT EXISTS google_play_codes (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL UNIQUE,
    service VARCHAR(20) NOT NULL DEFAULT 'google-play' CHECK (service = 'google-play'),
    code_ciphertext TEXT NOT NULL,
    code_fingerprint TEXT NOT NULL UNIQUE,
    provider_reference VARCHAR(200),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    FOREIGN KEY (transaction_id, service) REFERENCES transactions(id, service)
);

CREATE TABLE IF NOT EXISTS provider_events (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(100) NOT NULL,
    event_id VARCHAR(200) NOT NULL,
    transaction_id UUID REFERENCES transactions(id),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    processing_error TEXT,
    UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS provider_events_transaction_idx ON provider_events (transaction_id);

-- Bank fields are nullable for existing accounts. New registrations require them.
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS bank_account_holder VARCHAR(150);
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS bank_name VARCHAR(150);
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(18) CHECK (bank_account_number ~ '^[0-9]{9,18}$');
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(11) CHECK (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

CREATE TABLE IF NOT EXISTS distributor_wallets (
    distributor_id UUID PRIMARY KEY REFERENCES distributors(id),
    balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    reserved NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= balance),
    available NUMERIC(14,2) GENERATED ALWAYS AS (balance - reserved) STORED,
    currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO distributor_wallets (distributor_id) SELECT id FROM distributors ON CONFLICT DO NOTHING;

-- Snapshot at recharge creation. Old transactions deliberately have zero margin.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS distributor_id UUID REFERENCES distributors(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS distributor_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (distributor_rate BETWEEN 0 AND 100);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS distributor_commission_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (distributor_commission_rate BETWEEN 0 AND distributor_rate);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS distributor_commission_amount NUMERIC(14,2)
    GENERATED ALWAYS AS (round(amount * distributor_commission_rate / 100, 2)) STORED;

CREATE TABLE IF NOT EXISTS distributor_withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id UUID NOT NULL REFERENCES distributors(id),
    idempotency_key VARCHAR(150) NOT NULL CHECK (btrim(idempotency_key) <> ''),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
    bank_account_holder VARCHAR(150) NOT NULL,
    bank_name VARCHAR(150) NOT NULL,
    bank_account_number VARCHAR(18) NOT NULL,
    bank_ifsc VARCHAR(11) NOT NULL,
    payment_method VARCHAR(20),
    payment_reference VARCHAR(200),
    paid_at TIMESTAMPTZ,
    receipt_url TEXT,
    notes TEXT,
    rejection_reason TEXT,
    processed_by UUID REFERENCES admins(id),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (distributor_id, idempotency_key),
    CHECK (status <> 'paid' OR (payment_method IS NOT NULL AND payment_reference IS NOT NULL AND paid_at IS NOT NULL AND processed_by IS NOT NULL)),
    CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND processed_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS distributor_withdrawals_history_idx ON distributor_withdrawals (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS distributor_withdrawals_status_idx ON distributor_withdrawals (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS distributor_withdrawals_payment_unique ON distributor_withdrawals (payment_method, payment_reference) WHERE status = 'paid';

CREATE TABLE IF NOT EXISTS distributor_wallet_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id UUID NOT NULL REFERENCES distributor_wallets(distributor_id),
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('commission','withdrawal_hold','withdrawal_paid','withdrawal_release')),
    transaction_id UUID REFERENCES transactions(id),
    withdrawal_id UUID REFERENCES distributor_withdrawals(id),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    balance_after NUMERIC(14,2) NOT NULL,
    reserved_after NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((kind = 'commission' AND transaction_id IS NOT NULL AND withdrawal_id IS NULL)
        OR (kind <> 'commission' AND transaction_id IS NULL AND withdrawal_id IS NOT NULL)),
    UNIQUE (transaction_id, kind),
    UNIQUE (withdrawal_id, kind)
);
CREATE INDEX IF NOT EXISTS distributor_wallet_entries_history_idx ON distributor_wallet_entries (distributor_id, created_at DESC);

-- Each ledger insert updates balances once. Never update balances in controllers.
CREATE OR REPLACE FUNCTION post_distributor_wallet_entry() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    payment transactions%ROWTYPE;
    withdrawal distributor_withdrawals%ROWTYPE;
BEGIN
    IF NEW.kind = 'commission' THEN
        SELECT * INTO STRICT payment FROM transactions WHERE id = NEW.transaction_id FOR UPDATE;
        IF payment.status <> 'Successful' OR payment.service = 'wallet'
            OR payment.distributor_id IS DISTINCT FROM NEW.distributor_id
            OR NEW.amount <> payment.distributor_commission_amount
            OR NOT EXISTS (SELECT 1 FROM wallet_entries WHERE transaction_id = payment.id AND kind = 'recharge') THEN
            RAISE EXCEPTION 'Distributor commission requires a successful, debited recharge and its snapshotted margin' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM distributor_wallet_entries WHERE transaction_id = payment.id AND kind = NEW.kind) THEN
            RAISE EXCEPTION 'Commission already credited' USING ERRCODE = '23505';
        END IF;
    ELSE
        SELECT * INTO STRICT withdrawal FROM distributor_withdrawals WHERE id = NEW.withdrawal_id FOR UPDATE;
        IF withdrawal.distributor_id <> NEW.distributor_id OR withdrawal.amount <> NEW.amount
            OR (NEW.kind = 'withdrawal_hold' AND withdrawal.status <> 'pending')
            OR (NEW.kind = 'withdrawal_paid' AND withdrawal.status <> 'paid')
            OR (NEW.kind = 'withdrawal_release' AND withdrawal.status <> 'rejected') THEN
            RAISE EXCEPTION 'Withdrawal entry does not match request' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM distributor_wallet_entries WHERE withdrawal_id = withdrawal.id AND kind = NEW.kind) THEN
            RAISE EXCEPTION 'Withdrawal entry already posted' USING ERRCODE = '23505';
        END IF;
        IF NEW.kind <> 'withdrawal_hold' AND (NOT EXISTS (
            SELECT 1 FROM distributor_wallet_entries WHERE withdrawal_id = withdrawal.id AND kind = 'withdrawal_hold')
            OR EXISTS (SELECT 1 FROM distributor_wallet_entries WHERE withdrawal_id = withdrawal.id AND kind IN ('withdrawal_paid','withdrawal_release'))) THEN
            RAISE EXCEPTION 'Withdrawal must have one unprocessed hold' USING ERRCODE = '23514';
        END IF;
    END IF;
    UPDATE distributor_wallets SET
        balance = balance + CASE WHEN NEW.kind = 'commission' THEN NEW.amount WHEN NEW.kind = 'withdrawal_paid' THEN -NEW.amount ELSE 0 END,
        reserved = reserved + CASE WHEN NEW.kind = 'withdrawal_hold' THEN NEW.amount WHEN NEW.kind IN ('withdrawal_paid','withdrawal_release') THEN -NEW.amount ELSE 0 END,
        updated_at = NOW()
        WHERE distributor_id = NEW.distributor_id
        RETURNING balance, reserved INTO NEW.balance_after, NEW.reserved_after;
    IF NOT FOUND THEN RAISE EXCEPTION 'Distributor wallet not found'; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS distributor_wallet_entries_post ON distributor_wallet_entries;
CREATE TRIGGER distributor_wallet_entries_post BEFORE INSERT ON distributor_wallet_entries FOR EACH ROW EXECUTE FUNCTION post_distributor_wallet_entry();
DROP TRIGGER IF EXISTS distributor_wallet_entries_immutable ON distributor_wallet_entries;
CREATE TRIGGER distributor_wallet_entries_immutable BEFORE UPDATE OR DELETE ON distributor_wallet_entries FOR EACH ROW EXECUTE FUNCTION reject_wallet_entry_change();

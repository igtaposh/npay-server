CREATE TABLE IF NOT EXISTS staff_password_resets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'distributor')),
    admin_id UUID REFERENCES admins(id) ON DELETE CASCADE,
    distributor_id UUID REFERENCES distributors(id) ON DELETE CASCADE,
    credentials_version TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    reset_token_hash TEXT,
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((role = 'admin' AND admin_id IS NOT NULL AND distributor_id IS NULL)
        OR (role = 'distributor' AND distributor_id IS NOT NULL AND admin_id IS NULL))
);
CREATE INDEX IF NOT EXISTS staff_password_resets_admin_idx ON staff_password_resets (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS staff_password_resets_distributor_idx ON staff_password_resets (distributor_id, created_at DESC);

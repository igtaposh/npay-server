CREATE TABLE IF NOT EXISTS admins (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(10) NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
    email VARCHAR(255) NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    credentials_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS admins_email_lower_unique ON admins (lower(email));

-- Nullable for existing distributors: set a hash before enabling sign-in.
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS name VARCHAR(150);
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'closed'));
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS credentials_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS retailer_interests (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
    shop_address TEXT NOT NULL CHECK (btrim(shop_address) <> ''),
    phone VARCHAR(10) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
    distributor_id UUID REFERENCES distributors(id),
    retailer_id UUID UNIQUE REFERENCES retailers(id),
    status VARCHAR(20) NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'contacted', 'approved', 'rejected')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS retailer_interests_status_idx ON retailer_interests (status, created_at);
CREATE INDEX IF NOT EXISTS retailer_interests_distributor_idx ON retailer_interests (distributor_id);

CREATE TABLE IF NOT EXISTS retailer_verifications (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    retailer_id UUID NOT NULL REFERENCES retailers(id),
    purpose VARCHAR(30) NOT NULL CHECK (purpose IN
        ('password_reset', 'password_change', 'mpin_reset', 'email_change', 'phone_verify')),
    channel VARCHAR(10) NOT NULL CHECK (channel IN ('sms', 'email')),
    destination VARCHAR(255) NOT NULL,
    otp_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0 AND attempts <= max_attempts),
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR verified_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS retailer_verifications_lookup_idx
    ON retailer_verifications (retailer_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS retailer_sessions (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    retailer_id UUID NOT NULL REFERENCES retailers(id),
    refresh_token_hash TEXT NOT NULL UNIQUE,
    device_name TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS retailer_sessions_retailer_idx ON retailer_sessions (retailer_id);

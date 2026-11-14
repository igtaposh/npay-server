CREATE TABLE IF NOT EXISTS retailers (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id UUID NOT NULL REFERENCES distributors(id),
    name VARCHAR(254) NOT NULL CHECK (btrim(name) <> ''),
    business_name VARCHAR(150) NOT NULL CHECK (btrim(business_name) <> ''),
    phone VARCHAR(10) NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
    email VARCHAR(255) NOT NULL,
    business_address TEXT NOT NULL,
    pan VARCHAR(10) NOT NULL UNIQUE CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
    adhar VARCHAR(12) NOT NULL UNIQUE CHECK (adhar ~ '^[0-9]{12}$'),
    gst VARCHAR(15) UNIQUE,
    retailer_image_link TEXT,
    retailer_slug VARCHAR(100) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    mpin_hash TEXT,
    is_phone_verified BOOLEAN NOT NULL DEFAULT false,
    is_email_verified BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
    failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    login_locked_until TIMESTAMPTZ,
    failed_mpin_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_mpin_attempts >= 0),
    mpin_locked_until TIMESTAMPTZ,
    credentials_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS retailers_email_lower_unique ON retailers (lower(email));
CREATE INDEX IF NOT EXISTS retailers_distributor_id_idx ON retailers (distributor_id);

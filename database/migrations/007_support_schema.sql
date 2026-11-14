-- Supports founder/distributor/DRM/ARM cards; distributor_id scopes local contacts.
CREATE TABLE IF NOT EXISTS team_contacts (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id UUID REFERENCES distributors(id),
    role VARCHAR(20) NOT NULL CHECK (role IN ('founder', 'distributor', 'drm', 'arm')),
    role_full VARCHAR(200) NOT NULL,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    whatsapp VARCHAR(20),
    image_url TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE NULLS NOT DISTINCT (distributor_id, role)
);
ALTER TABLE privacy_policy ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE privacy_policy ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE faq ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE faq ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
-- Company contact can be a landline; retain the column name and permit +91.
ALTER TABLE company_details ALTER COLUMN phone TYPE VARCHAR(20);
ALTER TABLE company_details ALTER COLUMN whatsapp TYPE VARCHAR(20);
ALTER TABLE company_details DROP CONSTRAINT IF EXISTS company_phone_format;
ALTER TABLE company_details ADD CONSTRAINT company_phone_format
    CHECK (phone ~ '^\+?[0-9 ()-]{7,20}$') NOT VALID;

CREATE TABLE IF NOT EXISTS developer_details (
    id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    company VARCHAR(150) NOT NULL,
    role VARCHAR(150) NOT NULL,
    github VARCHAR(150),
    instagram VARCHAR(150),
    app_version VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END $$;
DO $$
DECLARE table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'privacy_policy', 'company_details', 'faq', 'commision_slab_by_admin',
        'distributors', 'retailers', 'admins', 'retailer_interests', 'service_operators',
        'telecom_circles', 'recharge_plans', 'retailer_commission_slabs', 'retailer_wallets',
        'transactions', 'team_contacts', 'developer_details'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', table_name);
        EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name);
    END LOOP;
END $$;

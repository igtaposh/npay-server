CREATE TABLE IF NOT EXISTS privacy_policy(
   id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
   title VARCHAR(200) NOT NULL,
   text TEXT NOT NULL,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS company_details(
   id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
   head_office TEXT NOT NULL,
   sub_office JSONB,
   email VARCHAR(255) NOT NULL,
   phone VARCHAR(10) NOT NULL,
   whatsapp VARCHAR(10),
   work_hours VARCHAR(150),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT company_email_format
        CHECK (email ~ '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'),
    CONSTRAINT company_phone_format
        CHECK (phone ~ '^[6-9]\d{9}$')
);
CREATE TABLE IF NOT EXISTS faq(
   id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
   question VARCHAR(200) NOT NULL,
   answer TEXT NOT NULL,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


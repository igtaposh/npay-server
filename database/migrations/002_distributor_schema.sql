CREATE TABLE IF NOT EXISTS distributors(
   id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
   business_name VARCHAR(150) NOT NULL,
   phone VARCHAR(10) NOT NULL UNIQUE,
   email VARCHAR(255) NOT NULL UNIQUE,
   business_address TEXT NOT NULL,
   pan VARCHAR(10) NOT NULL UNIQUE,
   adhar VARCHAR(12) NOT NULL UNIQUE,
   gst VARCHAR(15) UNIQUE,
   distributor_image_link TEXT NOT NULL,
   distributor_slug VARCHAR(100) NOT NULL UNIQUE,
   is_phone_verified BOOLEAN DEFAULT false,
   is_email_verified BOOLEAN DEFAULT false,

   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

   CONSTRAINT unique_distributor_phone UNIQUE (phone),
   CONSTRAINT unique_distributor_email UNIQUE (email)
);

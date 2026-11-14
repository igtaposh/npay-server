-- Reference identifiers from the app; provider credentials and live plans are configured separately.
INSERT INTO service_operators (code, name, service, account_label, account_digits, min_amount, max_amount) VALUES
    ('jio', 'Jio', 'prepaid', 'Mobile number', 10, 1, 100000),
    ('airtel', 'Airtel', 'prepaid', 'Mobile number', 10, 1, 100000),
    ('vi', 'Vi', 'prepaid', 'Mobile number', 10, 1, 100000),
    ('bsnl', 'BSNL', 'prepaid', 'Mobile number', 10, 1, 100000),
    ('tata-play', 'Tata Play', 'dth', 'subscriber ID', 10, 1, 25000),
    ('airtel-dth', 'Airtel Digital TV', 'dth', 'customer ID', 10, 1, 25000),
    ('dishtv', 'Dish TV', 'dth', 'VC number', 11, 1, 25000),
    ('d2h', 'd2h', 'dth', 'VC number', 11, 1, 25000),
    ('sun-direct', 'Sun Direct', 'dth', 'smart card number', 11, 1, 25000),
    ('google-play', 'Google Play', 'google-play', NULL, NULL, 100, 10000)
ON CONFLICT (code) DO NOTHING;

INSERT INTO telecom_circles (code, name) VALUES
    ('andhra-pradesh', 'Andhra Pradesh'),
    ('assam', 'Assam'),
    ('bihar-jharkhand', 'Bihar & Jharkhand'),
    ('chennai', 'Chennai'),
    ('delhi', 'Delhi'),
    ('gujarat', 'Gujarat'),
    ('haryana', 'Haryana'),
    ('himachal-pradesh', 'Himachal Pradesh'),
    ('jammu-kashmir', 'Jammu & Kashmir'),
    ('karnataka', 'Karnataka'),
    ('kerala', 'Kerala'),
    ('kolkata', 'Kolkata'),
    ('madhya-pradesh-chhattisgarh', 'Madhya Pradesh & Chhattisgarh'),
    ('maharashtra-goa', 'Maharashtra & Goa'),
    ('mumbai', 'Mumbai'),
    ('north-east', 'North East'),
    ('odisha', 'Odisha'),
    ('punjab', 'Punjab'),
    ('rajasthan', 'Rajasthan'),
    ('tamil-nadu', 'Tamil Nadu'),
    ('uttar-pradesh-east', 'Uttar Pradesh East'),
    ('uttar-pradesh-west', 'Uttar Pradesh West'),
    ('west-bengal', 'West Bengal')
ON CONFLICT (code) DO NOTHING;

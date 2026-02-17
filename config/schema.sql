-- Churches Table
CREATE TABLE IF NOT EXISTS churches (
    id SERIAL PRIMARY KEY,
    church_name VARCHAR(255) NOT NULL,
    branch_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    logo_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Programs Table
CREATE TABLE IF NOT EXISTS programs (
    id SERIAL PRIMARY KEY,
    church_id INTEGER REFERENCES churches(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    tracking_mode VARCHAR(50) NOT NULL, -- 'count-only' or 'collect-data'
    data_fields JSONB, -- Store selected fields as JSON
    gifting_enabled BOOLEAN DEFAULT FALSE,
    total_winners INTEGER DEFAULT 0,
    winners_selected INTEGER DEFAULT 0,
    qr_code_url VARCHAR(500),
    is_active BOOLEAN DEFAULT TRUE,
    total_scans INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Attendees Table
CREATE TABLE IF NOT EXISTS attendees (
    id SERIAL PRIMARY KEY,
    program_id INTEGER REFERENCES programs(id) ON DELETE CASCADE,
    full_name VARCHAR(255),
    phone_number VARCHAR(50),
    address TEXT,
    first_timer BOOLEAN DEFAULT FALSE,
    department VARCHAR(100),
    fellowship VARCHAR(100),
    age INTEGER,
    sex VARCHAR(20),
    is_winner BOOLEAN DEFAULT FALSE,
    device_fingerprint VARCHAR(500) NOT NULL,
    scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Scans Table (for tracking all scans, even anonymous ones)
CREATE TABLE IF NOT EXISTS scans (
    id SERIAL PRIMARY KEY,
    program_id INTEGER REFERENCES programs(id) ON DELETE CASCADE,
    device_fingerprint VARCHAR(500) NOT NULL,
    scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(program_id, device_fingerprint)
);

-- Indexes for performance
CREATE INDEX idx_programs_church_id ON programs(church_id);
CREATE INDEX idx_attendees_program_id ON attendees(program_id);
CREATE INDEX idx_scans_program_id ON scans(program_id);
CREATE INDEX idx_scans_device ON scans(device_fingerprint);
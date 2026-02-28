-- Migration: Add email verification and OTP fields to churches table
-- Run this against your existing database

ALTER TABLE churches ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;

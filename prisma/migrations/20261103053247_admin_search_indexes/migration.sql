-- CreateIndex
CREATE INDEX "profiles_handle_pattern_idx" ON "profiles"("handle" text_pattern_ops);

-- CreateIndex
CREATE INDEX "users_email_pattern_idx" ON "users"("email" text_pattern_ops);

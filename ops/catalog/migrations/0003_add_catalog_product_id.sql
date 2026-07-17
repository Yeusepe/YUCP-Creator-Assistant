ALTER TABLE package_versions
  ADD COLUMN catalog_product_id text
  CHECK (catalog_product_id IS NULL OR length(btrim(catalog_product_id)) BETWEEN 1 AND 256);

# Sample app fixture for dpdp-cli scans

export function withdrawConsent() {
  // consent withdrawal handler
  return true;
}

export function eraseUserAccount() {
  // rights erasure
  router.delete('/account', eraseUser);
}

// Privacy notice presented before processing.
// Retention: LOG_RETENTION_DAYS=365
// Breach / incident response escalation path.
// Vendor DPA required for processors.

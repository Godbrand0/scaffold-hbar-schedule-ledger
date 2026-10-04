use anyhow::{bail, Context, Result};
use std::time::Duration;

/// Runtime configuration, read from environment variables (see `.env.example`).
#[derive(Debug, Clone)]
pub struct Config {
    pub mirror_url: String,
    /// Contract to follow, as an EVM address (`0x...`) or a Hedera ID (`0.0.123`).
    pub contract: String,
    pub database_path: String,
    pub bind_addr: String,
    pub poll_interval: Duration,
    /// A pending schedule counts as overdue this many seconds after its expiry.
    pub overdue_grace_secs: i64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let contract = get("CONTRACT_ADDRESS")
            .filter(|v| !v.trim().is_empty())
            .context("CONTRACT_ADDRESS is required (deploy first, then set the address in packages/indexer/.env)")?;
        validate_contract(&contract)?;

        let poll_secs: u64 = parse_or(&get, "POLL_INTERVAL_SECS", 5)?;
        if poll_secs == 0 {
            bail!("POLL_INTERVAL_SECS must be at least 1");
        }

        Ok(Self {
            mirror_url: get("MIRROR_NODE_URL")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "https://testnet.mirrornode.hedera.com".to_string())
                .trim_end_matches('/')
                .to_string(),
            contract: contract.trim().to_string(),
            database_path: get("DATABASE_PATH").unwrap_or_else(|| "indexer.db".to_string()),
            bind_addr: get("BIND_ADDR").unwrap_or_else(|| "127.0.0.1:4000".to_string()),
            poll_interval: Duration::from_secs(poll_secs),
            overdue_grace_secs: parse_or(&get, "OVERDUE_GRACE_SECS", 60)?,
        })
    }
}

fn parse_or<T: std::str::FromStr>(get: &impl Fn(&str) -> Option<String>, key: &str, default: T) -> Result<T> {
    match get(key).filter(|v| !v.trim().is_empty()) {
        Some(raw) => raw
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("{key} has an invalid value: {raw}")),
        None => Ok(default),
    }
}

fn validate_contract(value: &str) -> Result<()> {
    let v = value.trim();
    let is_evm = v.len() == 42 && v.starts_with("0x") && v[2..].chars().all(|c| c.is_ascii_hexdigit());
    let is_id = {
        let parts: Vec<&str> = v.split('.').collect();
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    };
    if !is_evm && !is_id {
        bail!("CONTRACT_ADDRESS must be a 0x EVM address or a 0.0.N Hedera ID, got: {value}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Result<Config> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn applies_defaults() {
        let c = cfg(&[("CONTRACT_ADDRESS", "0.0.1234")]).unwrap();
        assert_eq!(c.mirror_url, "https://testnet.mirrornode.hedera.com");
        assert_eq!(c.bind_addr, "127.0.0.1:4000");
        assert_eq!(c.poll_interval, Duration::from_secs(5));
        assert_eq!(c.overdue_grace_secs, 60);
    }

    #[test]
    fn requires_contract() {
        assert!(cfg(&[]).is_err());
        assert!(cfg(&[("CONTRACT_ADDRESS", "  ")]).is_err());
    }

    #[test]
    fn accepts_evm_address_and_hedera_id_only() {
        assert!(cfg(&[("CONTRACT_ADDRESS", "0x0000000000000000000000000000000000120f46")]).is_ok());
        assert!(cfg(&[("CONTRACT_ADDRESS", "0.0.1183558")]).is_ok());
        assert!(cfg(&[("CONTRACT_ADDRESS", "0x1234")]).is_err());
        assert!(cfg(&[("CONTRACT_ADDRESS", "0.0.abc")]).is_err());
        assert!(cfg(&[("CONTRACT_ADDRESS", "banana")]).is_err());
    }

    #[test]
    fn trims_trailing_slash_from_mirror_url() {
        let c = cfg(&[("CONTRACT_ADDRESS", "0.0.1"), ("MIRROR_NODE_URL", "http://x.test/")]).unwrap();
        assert_eq!(c.mirror_url, "http://x.test");
    }

    #[test]
    fn rejects_bad_numbers() {
        assert!(cfg(&[("CONTRACT_ADDRESS", "0.0.1"), ("POLL_INTERVAL_SECS", "0")]).is_err());
        assert!(cfg(&[("CONTRACT_ADDRESS", "0.0.1"), ("POLL_INTERVAL_SECS", "fast")]).is_err());
    }
}

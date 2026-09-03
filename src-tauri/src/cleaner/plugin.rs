use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CleanRecommendation {
    SafeToQuarantine,
    Caution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub last_modified: u64, // Unix timestamp in seconds
    pub product_name: Option<String>,
    pub author: Option<String>,
    pub package_code: Option<String>,
    pub comments: Option<String>,
    pub recommendation: CleanRecommendation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanerScanResult {
    pub plugin_id: String,
    pub items: Vec<CleanItem>,
    pub total_bytes: u64,
    pub active_count: usize,
    pub active_bytes: u64,
    pub scanned_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CleanAction {
    Quarantine { target_dir: String },
    Rename { prefix: String },
    Delete { permanent: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanItemResult {
    pub path: String,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanExecutionResult {
    pub processed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub freed_bytes: u64,
    pub details: Vec<CleanItemResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanerPluginInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub requires_admin: bool,
}

pub trait CleanerPlugin: Send + Sync {
    fn info(&self) -> CleanerPluginInfo;
    fn scan(&self) -> Result<CleanerScanResult, String>;
    fn execute(
        &self,
        action: CleanAction,
        item_paths: Vec<String>,
    ) -> Result<CleanExecutionResult, String>;
}

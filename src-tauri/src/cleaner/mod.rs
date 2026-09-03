pub mod plugin;
pub mod windows_installer;

use plugin::{
    CleanAction, CleanExecutionResult, CleanerPlugin, CleanerPluginInfo, CleanerScanResult,
};
use std::sync::Mutex;
use windows_installer::WindowsInstallerCleaner;

pub struct CleanerRegistry {
    plugins: Vec<Box<dyn CleanerPlugin>>,
}

impl Default for CleanerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CleanerRegistry {
    pub fn new() -> Self {
        let mut registry = Self {
            plugins: Vec::new(),
        };
        // Register default built-in cleaners
        registry.register(Box::new(WindowsInstallerCleaner::new()));
        registry
    }

    pub fn register(&mut self, plugin: Box<dyn CleanerPlugin>) {
        self.plugins.push(plugin);
    }

    pub fn list_plugins(&self) -> Vec<CleanerPluginInfo> {
        self.plugins.iter().map(|p| p.info()).collect()
    }

    pub fn scan(&self, plugin_id: &str) -> Result<CleanerScanResult, String> {
        let plugin = self
            .plugins
            .iter()
            .find(|p| p.info().id == plugin_id)
            .ok_or_else(|| format!("未找到指定的清理插件: {}", plugin_id))?;

        plugin.scan()
    }

    pub fn execute(
        &self,
        plugin_id: &str,
        action: CleanAction,
        items: Vec<String>,
    ) -> Result<CleanExecutionResult, String> {
        let plugin = self
            .plugins
            .iter()
            .find(|p| p.info().id == plugin_id)
            .ok_or_else(|| format!("未找到指定的清理插件: {}", plugin_id))?;

        plugin.execute(action, items)
    }
}

pub type CleanerState = Mutex<CleanerRegistry>;

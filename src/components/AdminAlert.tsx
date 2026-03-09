import React from 'react';
import { ShieldAlert, X, ChevronRight } from 'lucide-react';

interface Props {
    onClose: () => void;
}

export const AdminAlert: React.FC<Props> = ({ onClose }) => {
    return (
        <div className="admin-alert-overlay">
            <div className="admin-alert-card">
                <div className="admin-alert-glow"></div>
                <button className="admin-alert-close" onClick={onClose}>
                    <X size={18} />
                </button>
                <div className="admin-alert-content">
                    <div className="admin-alert-icon-wrapper">
                        <ShieldAlert size={32} />
                    </div>
                    <div className="admin-alert-text">
                        <h3>权限受限提示</h3>
                        <p>当前未以<b>管理员身份</b>运行。这会导致以下影响：</p>
                        <ul className="admin-alert-list">
                            <li>
                                <ChevronRight size={14} />
                                <span>无法使用 <b>NTFS MFT</b> 高速扫描引擎</span>
                            </li>
                            <li>
                                <ChevronRight size={14} />
                                <span>扫描受保护的系统目录可能会失败</span>
                            </li>
                        </ul>
                        <div className="admin-alert-footer">
                            <p>建议右键点击图标选择“以管理员身份运行”以获得最佳体验。</p>
                            <button className="btn btn-primary admin-alert-btn" onClick={onClose}>
                                我知道了
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <style dangerouslySetInnerHTML={{
                __html: `
                .admin-alert-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.4);
                    backdrop-filter: blur(8px);
                    -webkit-backdrop-filter: blur(8px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 9999;
                    animation: fadeIn 0.3s ease-out;
                }
                .admin-alert-card {
                    background: rgba(255, 255, 255, 0.85);
                    backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.3);
                    border-radius: 20px;
                    width: 480px;
                    max-width: 90vw;
                    padding: 32px;
                    position: relative;
                    overflow: hidden;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
                    animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                }
                .admin-alert-glow {
                    position: absolute;
                    top: -50px;
                    right: -50px;
                    width: 150px;
                    height: 150px;
                    background: radial-gradient(circle, rgba(59, 130, 246, 0.2) 0%, rgba(59, 130, 246, 0) 70%);
                    z-index: 0;
                }
                .admin-alert-close {
                    position: absolute;
                    top: 16px;
                    right: 16px;
                    background: transparent;
                    border: none;
                    color: var(--text-secondary);
                    cursor: pointer;
                    opacity: 0.6;
                    transition: opacity 0.2s;
                    z-index: 2;
                }
                .admin-alert-close:hover {
                    opacity: 1;
                }
                .admin-alert-content {
                    display: flex;
                    gap: 24px;
                    position: relative;
                    z-index: 1;
                }
                .admin-alert-icon-wrapper {
                    width: 64px;
                    height: 64px;
                    background: rgba(59, 130, 246, 0.1);
                    border-radius: 16px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--accent-color);
                    flex-shrink: 0;
                }
                .admin-alert-text h3 {
                    font-size: 1.25rem;
                    font-weight: 700;
                    margin-bottom: 12px;
                    color: var(--text-primary);
                }
                .admin-alert-text p {
                    font-size: 0.95rem;
                    line-height: 1.5;
                    color: var(--text-secondary);
                    margin-bottom: 16px;
                }
                .admin-alert-list {
                    list-style: none;
                    padding: 0;
                    margin: 0 0 24px 0;
                }
                .admin-alert-list li {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 0.9rem;
                    color: var(--text-primary);
                    margin-bottom: 8px;
                }
                .admin-alert-list li svg {
                    color: var(--accent-color);
                }
                .admin-alert-footer {
                    margin-top: 32px;
                    padding-top: 24px;
                    border-top: 1px solid rgba(0, 0, 0, 0.05);
                }
                .admin-alert-footer p {
                    font-size: 0.85rem;
                    font-style: italic;
                    margin-bottom: 20px;
                }
                .admin-alert-btn {
                    width: 100%;
                    height: 44px;
                    border-radius: 12px;
                    justify-content: center;
                    font-size: 1rem;
                }
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes slideUp {
                    from { opacity: 0; transform: translateY(30px) scale(0.95); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
            ` }} />
        </div>
    );
};

/**
 * 兼容入口:真正的实现在 web/scripts/(随 web 一起部署,web 进程才能在后台调它刷新索引)。
 * CLI 用法不变:CastaliaNode.exe scripts/build_search_index.mjs [--force]
 */
import './../web/scripts/build_search_index.mjs';

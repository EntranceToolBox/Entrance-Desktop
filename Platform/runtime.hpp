#pragma once
#include <filesystem>
#include <string>
namespace desktop {
namespace fs = std::filesystem;

struct Runtime {
    fs::path node;
    fs::path adapter;
    fs::path backend;
};

inline Runtime runtime(const fs::path &executable) {
    const fs::path bin = executable.parent_path();
    const fs::path resources = bin.parent_path() / "share" / "entrance-desktop";
    if (fs::exists(resources / "backend.cjs")) {
#ifdef _WIN32
        return {bin / "node.exe", resources / "backend.cjs", resources / "Entrance"};
#else
        const fs::path node = bin / "node";
        return {fs::exists(node) ? node : fs::path("node"), resources / "backend.cjs", resources / "Entrance"};
#endif
    }
    const fs::path root = fs::u8path(SOURCE_ROOT);
    return {fs::u8path(DEV_NODE), root / "Platform/backend.cjs", root / "Entrance"};
}

inline std::string origin(const std::string &url) {
    const std::size_t scheme = url.find("://");
    if (scheme == std::string::npos) return {};
    return url.substr(0, url.find('/', scheme + 3));
}
}

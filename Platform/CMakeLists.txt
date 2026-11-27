cmake_minimum_required(VERSION 3.20)
project(EntranceDesktop VERSION 0.1.7.1 LANGUAGES CXX)
set(DESKTOP_VERSION "${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR}.${PROJECT_VERSION_PATCH}-${PROJECT_VERSION_TWEAK}")
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin")
get_filename_component(ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(DIST_DIR "${ROOT}/Desktop/dist")
find_program(NODE_EXECUTABLE node REQUIRED)
file(TO_CMAKE_PATH "${NODE_EXECUTABLE}" NODE_EXECUTABLE)
set(BACKEND_MODULES "${ROOT}/Entrance/node_modules" CACHE PATH "Installed backend dependencies for the target OS")
if(WIN32)
  if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
  endif()
  include(FetchContent)
  FetchContent_Declare(webview2 DOWNLOAD_NAME webview2.zip
    URL_HASH SHA256=ef128016dd1e51c59178c827ed5b8aa3322c57afa8675d930f8109505542ad74
    URL https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg)
  FetchContent_MakeAvailable(webview2)
  if(CMAKE_GENERATOR_PLATFORM MATCHES "[Aa][Rr][Mm]64" OR CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|aarch64")
    set(arch arm64)
  elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(arch x64)
  else()
    set(arch x86)
  endif()
  configure_file(Windows/icon.rc.in icon.rc @ONLY)
  add_executable(entrance-desktop WIN32 Windows/main.cpp "${CMAKE_CURRENT_BINARY_DIR}/icon.rc")
  target_include_directories(entrance-desktop PRIVATE "${webview2_SOURCE_DIR}/build/native/include")
  if(MINGW)
    # The SDK uses Microsoft's filename casing for this MinGW system header.
    if(CMAKE_CROSSCOMPILING)
      file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/EventToken.h" "#include <eventtoken.h>\n")
      target_include_directories(entrance-desktop PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
    endif()
    set(loader "${webview2_SOURCE_DIR}/build/native/${arch}/WebView2Loader.dll")
    target_link_libraries(entrance-desktop PRIVATE "${loader}")
    target_link_options(entrance-desktop PRIVATE -municode -static)
    install(FILES "${loader}" DESTINATION bin)
  else()
    target_compile_options(entrance-desktop PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:/utf-8>")
    target_link_libraries(entrance-desktop PRIVATE "${webview2_SOURCE_DIR}/build/native/${arch}/WebView2LoaderStatic.lib")
  endif()
  target_compile_definitions(entrance-desktop PRIVATE UNICODE _UNICODE NOMINMAX)
  target_link_libraries(entrance-desktop PRIVATE uuid dwmapi ole32 shell32 shlwapi version advapi32 user32)
  if(CMAKE_CROSSCOMPILING)
    FetchContent_Declare(windows_node
      URL https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip
      URL_HASH SHA256=e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f)
    FetchContent_MakeAvailable(windows_node)
    set(NODE_EXECUTABLE "${windows_node_SOURCE_DIR}/node.exe")
    install(FILES "${windows_node_SOURCE_DIR}/LICENSE" DESTINATION bin RENAME node-LICENSE)
    set(prebuild_filter REGEX "/prebuilds/(darwin|linux|android|freebsd|win32-ia32|win32-arm64)[^/]*" EXCLUDE)
  endif()
  install(PROGRAMS "${NODE_EXECUTABLE}" DESTINATION bin RENAME node.exe)
  find_program(MAKENSIS makensis
    PATHS "$ENV{ProgramFiles}/NSIS" "$ENV{ProgramFiles\(x86\)}/NSIS" "$ENV{ELECTRON_BUILDER_CACHE}/nsis/nsis-3.0.4.1/linux"
          "$ENV{HOME}/.cache/electron-builder/nsis/nsis-3.0.4.1/linux"
    NO_CMAKE_FIND_ROOT_PATH)
  if(NOT MAKENSIS)
    set(MAKENSIS makensis) # Only packaging requires NSIS on PATH.
  endif()
  get_filename_component(nsis_bin "${MAKENSIS}" DIRECTORY)
  get_filename_component(nsis_root "${nsis_bin}/.." ABSOLUTE)
  if(EXISTS "${nsis_root}/Stubs")
    set(nsis_env "NSISDIR=${nsis_root}")
  endif()
  set(payload "${CMAKE_CURRENT_BINARY_DIR}/installer-payload")
  set(installer_name "Entrance-Desktop-Setup-${DESKTOP_VERSION}-Windows-${arch}.exe")
  configure_file(Windows/installer.nsi.in installer.nsi @ONLY)
  add_custom_target(installer
    COMMAND "${CMAKE_COMMAND}" -E rm -rf "${payload}"
    COMMAND "${CMAKE_COMMAND}" --install "${CMAKE_BINARY_DIR}" --config Release --prefix "${payload}"
    COMMAND "${CMAKE_COMMAND}" -E env ${nsis_env} "${MAKENSIS}" "${CMAKE_CURRENT_BINARY_DIR}/installer.nsi"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${DIST_DIR}"
    COMMAND "${CMAKE_COMMAND}" -E copy "${CMAKE_CURRENT_BINARY_DIR}/${installer_name}" "${DIST_DIR}/${installer_name}"
    DEPENDS entrance-desktop
    USES_TERMINAL VERBATIM)
else()
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(GTK REQUIRED IMPORTED_TARGET libadwaita-1 webkitgtk-6.0)
  add_executable(entrance-desktop Linux/main.cpp)
  target_link_libraries(entrance-desktop PRIVATE PkgConfig::GTK)
  install(FILES "${ROOT}/Share/Linux/entrance-desktop.desktop" DESTINATION share/applications)
  install(FILES "${ROOT}/Share/Linux/entrance-desktop.png" DESTINATION share/icons/hicolor/512x512/apps)
  add_custom_target(appimage
    COMMAND bash "${CMAKE_CURRENT_SOURCE_DIR}/Linux/appimage.sh"
      "${CMAKE_BINARY_DIR}" "${DIST_DIR}" "${DESKTOP_VERSION}" "${NODE_EXECUTABLE}"
    DEPENDS entrance-desktop
    USES_TERMINAL VERBATIM)
endif()
target_compile_definitions(entrance-desktop PRIVATE SOURCE_ROOT=u8"${ROOT}" DEV_NODE=u8"${NODE_EXECUTABLE}")
install(TARGETS entrance-desktop RUNTIME DESTINATION bin)
install(FILES backend.cjs DESTINATION share/entrance-desktop)
foreach(file server.js flash-debug.js local-shell.js vnc.js remote-serial.js package.json LICENSE)
  install(FILES "${ROOT}/Entrance/${file}" DESTINATION share/entrance-desktop/Entrance)
endforeach()
install(DIRECTORY "${ROOT}/Entrance/public" "${ROOT}/Entrance/api" "${BACKEND_MODULES}"
  DESTINATION share/entrance-desktop/Entrance PATTERN ".bin" EXCLUDE ${prebuild_filter})

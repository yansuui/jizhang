#!/usr/bin/env python3
"""Generate the checked-in Xcode project deterministically, without XcodeGen."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "Jizhang.xcodeproj"
objects: dict[str, dict] = {}


def identifier(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()


def add(object_name: str, isa: str, **values) -> str:
    key = identifier(object_name)
    if key in objects:
        raise ValueError(f"Duplicate project object: {object_name}")
    objects[key] = {"isa": isa, **values}
    return key


def serialize(value, depth: int = 0) -> str:
    pad = "\t" * depth
    if isinstance(value, dict):
        lines = ["{"]
        for key, item in value.items():
            lines.append(f"{pad}\t{json.dumps(key)} = {serialize(item, depth + 1)};")
        return "\n".join(lines) + f"\n{pad}}}"
    if isinstance(value, list):
        return "(\n" + "".join(f"{pad}\t{serialize(x, depth + 1)},\n" for x in value) + pad + ")"
    if isinstance(value, int):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def source_objects(folder: str, build_prefix: str = "") -> tuple[list[str], list[str]]:
    """Register one file reference per Swift file and one build file per compilation phase.

    Shared sources belong to more than one target, so the reference is reused while the build
    file name carries the owning phase. `build_prefix` must therefore be unique per phase.
    """
    refs, builds = [], []
    for path in sorted((ROOT / folder).rglob("*.swift")):
        relative = path.relative_to(ROOT).as_posix()
        ref_name = f"ref:{relative}"
        key = identifier(ref_name)
        if key not in objects:
            add(ref_name, "PBXFileReference", lastKnownFileType="sourcecode.swift",
                path=relative, sourceTree="SOURCE_ROOT")
        refs.append(key)
        builds.append(add(f"build:{build_prefix}{relative}", "PBXBuildFile", fileRef=key))
    if not refs:
        raise SystemExit(f"No Swift source found in {folder}")
    return refs, builds


def require_file(relative: str, file_type: str, object_name: str) -> str:
    if not (ROOT / relative).exists():
        raise SystemExit(f"Required file missing: {relative}")
    return add(object_name, "PBXFileReference", lastKnownFileType=file_type,
               path=relative, sourceTree="SOURCE_ROOT")


def configuration_list(name: str, settings: dict) -> str:
    configurations = []
    for mode in ("Debug", "Release"):
        config = dict(settings)
        if mode == "Debug":
            config.update(SWIFT_OPTIMIZATION_LEVEL="-Onone", ENABLE_TESTABILITY="YES",
                          SWIFT_ACTIVE_COMPILATION_CONDITIONS="DEBUG $(inherited)",
                          DEBUG_INFORMATION_FORMAT="dwarf")
        else:
            config.update(SWIFT_OPTIMIZATION_LEVEL="-O", SWIFT_COMPILATION_MODE="wholemodule",
                          DEBUG_INFORMATION_FORMAT="dwarf-with-dsym")
        configurations.append(add(f"config:{name}:{mode}", "XCBuildConfiguration",
                                  buildSettings=config, name=mode))
    return add(f"config-list:{name}", "XCConfigurationList", buildConfigurations=configurations,
               defaultConfigurationIsVisible=0, defaultConfigurationName="Release")


def build_reference(parent: ET.Element, target: str, product: str) -> None:
    ET.SubElement(parent, "BuildableReference", BuildableIdentifier="primary",
                  BlueprintIdentifier=identifier(f"target:{target}"), BuildableName=product,
                  BlueprintName=target, ReferencedContainer="container:Jizhang.xcodeproj")


def main() -> None:
    app_refs, app_builds = source_objects("Jizhang")
    shared_refs, shared_app_builds = source_objects("Shared", "shared-app:")
    _, shared_widget_builds = source_objects("Shared", "shared-widgets:")
    widget_refs, widget_builds = source_objects("JizhangWidgets", "widgets:")
    test_refs, test_builds = source_objects("JizhangTests")
    resource_refs, resource_builds = [], []
    for path, file_type in (("Jizhang/Assets.xcassets", "folder.assetcatalog"),
                            ("Jizhang/PrivacyInfo.xcprivacy", "text.xml")):
        resource_refs.append(require_file(path, file_type, f"ref:{path}"))
        resource_builds.append(add(f"build:{path}", "PBXBuildFile", fileRef=resource_refs[-1]))
    info_ref = require_file("Jizhang/Info.plist", "text.plist.xml", "info")
    app_entitlements_ref = require_file("Jizhang/Jizhang.entitlements", "text.plist.entitlements",
                                        "ref:Jizhang/Jizhang.entitlements")
    widget_plist_ref = require_file("JizhangWidgets/Info.plist", "text.plist.xml",
                                    "ref:JizhangWidgets/Info.plist")
    widget_entitlements_ref = require_file("JizhangWidgets/JizhangWidgets.entitlements",
                                           "text.plist.entitlements",
                                           "ref:JizhangWidgets/JizhangWidgets.entitlements")
    app_product = add("product:app", "PBXFileReference", explicitFileType="wrapper.application",
                      includeInIndex=0, path="Jizhang.app", sourceTree="BUILT_PRODUCTS_DIR")
    widget_product = add("product:widgets", "PBXFileReference", explicitFileType="wrapper.app-extension",
                         includeInIndex=0, path="JizhangWidgets.appex", sourceTree="BUILT_PRODUCTS_DIR")
    test_product = add("product:tests", "PBXFileReference", explicitFileType="wrapper.cfbundle",
                       includeInIndex=0, path="JizhangTests.xctest", sourceTree="BUILT_PRODUCTS_DIR")
    sources_group = add("group:sources", "PBXGroup", children=app_refs, name="Sources", sourceTree="<group>")
    shared_group = add("group:shared", "PBXGroup", children=shared_refs, name="Shared", sourceTree="<group>")
    widgets_group = add("group:widgets", "PBXGroup",
                        children=widget_refs + [widget_plist_ref, widget_entitlements_ref],
                        name="Widgets", sourceTree="<group>")
    tests_group = add("group:tests", "PBXGroup", children=test_refs, name="Tests", sourceTree="<group>")
    resources_group = add("group:resources", "PBXGroup",
                          children=resource_refs + [info_ref, app_entitlements_ref],
                          name="Resources", sourceTree="<group>")
    products_group = add("group:products", "PBXGroup",
                         children=[app_product, widget_product, test_product],
                         name="Products", sourceTree="<group>")
    main_group = add("group:main", "PBXGroup",
                     children=[sources_group, shared_group, widgets_group, tests_group,
                               resources_group, products_group],
                     sourceTree="<group>")
    app_sources = add("phase:app-sources", "PBXSourcesBuildPhase", buildActionMask=2147483647,
                      files=app_builds + shared_app_builds, runOnlyForDeploymentPostprocessing=0)
    widget_sources = add("phase:widget-sources", "PBXSourcesBuildPhase", buildActionMask=2147483647,
                         files=widget_builds + shared_widget_builds, runOnlyForDeploymentPostprocessing=0)
    test_sources = add("phase:test-sources", "PBXSourcesBuildPhase", buildActionMask=2147483647,
                       files=test_builds, runOnlyForDeploymentPostprocessing=0)
    resources = add("phase:resources", "PBXResourcesBuildPhase", buildActionMask=2147483647,
                    files=resource_builds, runOnlyForDeploymentPostprocessing=0)
    widget_resources = add("phase:widget-resources", "PBXResourcesBuildPhase", buildActionMask=2147483647,
                           files=[], runOnlyForDeploymentPostprocessing=0)
    app_frameworks = add("phase:app-frameworks", "PBXFrameworksBuildPhase", buildActionMask=2147483647,
                         files=[], runOnlyForDeploymentPostprocessing=0)
    widget_frameworks = add("phase:widget-frameworks", "PBXFrameworksBuildPhase", buildActionMask=2147483647,
                            files=[], runOnlyForDeploymentPostprocessing=0)
    test_frameworks = add("phase:test-frameworks", "PBXFrameworksBuildPhase", buildActionMask=2147483647,
                          files=[], runOnlyForDeploymentPostprocessing=0)
    embed_widget = add("build:embed-widgets", "PBXBuildFile", fileRef=widget_product,
                       settings={"ATTRIBUTES": ["RemoveHeadersOnCopy"]})
    embed_extensions = add("phase:embed-extensions", "PBXCopyFilesBuildPhase",
                           buildActionMask=2147483647, dstPath="", dstSubfolderSpec=13,
                           files=[embed_widget], name="Embed Foundation Extensions",
                           runOnlyForDeploymentPostprocessing=0)
    common = dict(SDKROOT="iphoneos", IPHONEOS_DEPLOYMENT_TARGET="17.0", SWIFT_VERSION="5.0",
                  CLANG_ENABLE_MODULES="YES", CLANG_ENABLE_OBJC_ARC="YES", GCC_C_LANGUAGE_STANDARD="gnu17",
                  SWIFT_STRICT_CONCURRENCY="targeted", ENABLE_USER_SCRIPT_SANDBOXING="YES")
    project_configs = configuration_list("project", common)
    target_base = dict(CODE_SIGN_STYLE="Automatic", TARGETED_DEVICE_FAMILY="1",
                       SUPPORTED_PLATFORMS="iphoneos iphonesimulator", SUPPORTS_MACCATALYST="NO",
                       PRODUCT_NAME="$(TARGET_NAME)", MARKETING_VERSION="0.1.0", CURRENT_PROJECT_VERSION="1",
                       LD_RUNPATH_SEARCH_PATHS=["$(inherited)", "@executable_path/Frameworks"])
    app_configs = configuration_list("app", dict(target_base,
        PRODUCT_BUNDLE_IDENTIFIER="com.yansuu1.jizhang.ios", GENERATE_INFOPLIST_FILE="NO",
        INFOPLIST_FILE="Jizhang/Info.plist", CODE_SIGN_ENTITLEMENTS="Jizhang/Jizhang.entitlements",
        ASSETCATALOG_COMPILER_APPICON_NAME="AppIcon",
        ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME="AccentColor"))
    widget_configs = configuration_list("widgets", dict(target_base,
        PRODUCT_BUNDLE_IDENTIFIER="com.yansuu1.jizhang.ios.widgets", GENERATE_INFOPLIST_FILE="NO",
        INFOPLIST_FILE="JizhangWidgets/Info.plist",
        CODE_SIGN_ENTITLEMENTS="JizhangWidgets/JizhangWidgets.entitlements",
        APPLICATION_EXTENSION_API_ONLY="YES", SKIP_INSTALL="YES", SWIFT_EMIT_LOC_STRINGS="NO",
        LD_RUNPATH_SEARCH_PATHS=["$(inherited)", "@executable_path/Frameworks",
                                 "@executable_path/../../Frameworks"]))
    widget_target = add("target:JizhangWidgets", "PBXNativeTarget", buildConfigurationList=widget_configs,
        buildPhases=[widget_sources, widget_frameworks, widget_resources], buildRules=[], dependencies=[],
        name="JizhangWidgets", productName="JizhangWidgets", productReference=widget_product,
        productType="com.apple.product-type.app-extension")
    widget_proxy = add("proxy:widgets", "PBXContainerItemProxy", containerPortal=identifier("project"),
                       proxyType=1, remoteGlobalIDString=widget_target, remoteInfo="JizhangWidgets")
    widget_dependency = add("dependency:widgets", "PBXTargetDependency", target=widget_target,
                            targetProxy=widget_proxy)
    app_target = add("target:Jizhang", "PBXNativeTarget", buildConfigurationList=app_configs,
        buildPhases=[app_sources, app_frameworks, resources, embed_extensions], buildRules=[],
        dependencies=[widget_dependency], name="Jizhang", productName="Jizhang",
        productReference=app_product, productType="com.apple.product-type.application")
    proxy = add("proxy:app", "PBXContainerItemProxy", containerPortal=identifier("project"),
                 proxyType=1, remoteGlobalIDString=app_target, remoteInfo="Jizhang")
    dependency = add("dependency:app", "PBXTargetDependency", target=app_target, targetProxy=proxy)
    test_configs = configuration_list("tests", dict(target_base,
        PRODUCT_BUNDLE_IDENTIFIER="com.yansuu1.jizhang.ios.tests", GENERATE_INFOPLIST_FILE="YES",
        TEST_HOST="$(BUILT_PRODUCTS_DIR)/Jizhang.app/Jizhang", BUNDLE_LOADER="$(TEST_HOST)"))
    test_target = add("target:JizhangTests", "PBXNativeTarget", buildConfigurationList=test_configs,
        buildPhases=[test_sources, test_frameworks], buildRules=[], dependencies=[dependency],
        name="JizhangTests", productName="JizhangTests", productReference=test_product,
        productType="com.apple.product-type.bundle.unit-test")
    project = add("project", "PBXProject", attributes={"BuildIndependentTargetsInParallel": "YES",
        "LastUpgradeCheck": "1600", "TargetAttributes": {
            app_target: {"CreatedOnToolsVersion": "16.4"},
            widget_target: {"CreatedOnToolsVersion": "16.4"},
            test_target: {"CreatedOnToolsVersion": "16.4", "TestTargetID": app_target}}},
        buildConfigurationList=project_configs, compatibilityVersion="Xcode 14.0", developmentRegion="zh-Hans",
        hasScannedForEncodings=0, knownRegions=["en", "zh-Hans", "Base"], mainGroup=main_group,
        productRefGroup=products_group, projectDirPath="", projectRoot="",
        targets=[app_target, widget_target, test_target])
    PROJECT.mkdir(parents=True, exist_ok=True)
    data = dict(archiveVersion=1, classes={}, objectVersion=56, objects=objects, rootObject=project)
    (PROJECT / "project.pbxproj").write_text("// !$*UTF8*$!\n" + serialize(data) + "\n", encoding="utf-8", newline="\n")
    scheme = ET.Element("Scheme", LastUpgradeVersion="1600", version="1.7")
    build = ET.SubElement(scheme, "BuildAction", parallelizeBuildables="YES", buildImplicitDependencies="YES")
    entries = ET.SubElement(build, "BuildActionEntries")
    for target, product in (("Jizhang", "Jizhang.app"), ("JizhangTests", "JizhangTests.xctest")):
        other = "YES" if target == "Jizhang" else "NO"
        entry = ET.SubElement(entries, "BuildActionEntry", buildForTesting="YES", buildForRunning=other,
                              buildForProfiling=other, buildForArchiving=other, buildForAnalyzing=other)
        build_reference(entry, target, product)
    test = ET.SubElement(scheme, "TestAction", buildConfiguration="Debug",
        selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB",
        selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB", shouldUseLaunchSchemeArgsEnv="YES")
    testable = ET.SubElement(ET.SubElement(test, "Testables"), "TestableReference", skipped="NO")
    build_reference(testable, "JizhangTests", "JizhangTests.xctest")
    launch = ET.SubElement(scheme, "LaunchAction", buildConfiguration="Debug",
        selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB",
        selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB", launchStyle="0",
        useCustomWorkingDirectory="NO", ignoresPersistentStateOnLaunch="NO", debugDocumentVersioning="YES",
        debugServiceExtension="internal", allowLocationSimulation="YES")
    build_reference(ET.SubElement(launch, "BuildableProductRunnable", runnableDebuggingMode="0"), "Jizhang", "Jizhang.app")
    profile = ET.SubElement(scheme, "ProfileAction", buildConfiguration="Release", shouldUseLaunchSchemeArgsEnv="YES",
                            savedToolIdentifier="", useCustomWorkingDirectory="NO", debugDocumentVersioning="YES")
    build_reference(ET.SubElement(profile, "BuildableProductRunnable", runnableDebuggingMode="0"), "Jizhang", "Jizhang.app")
    ET.SubElement(scheme, "AnalyzeAction", buildConfiguration="Debug")
    ET.SubElement(scheme, "ArchiveAction", buildConfiguration="Release", revealArchiveInOrganizer="YES")
    ET.indent(scheme)
    scheme_dir = PROJECT / "xcshareddata" / "xcschemes"
    scheme_dir.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(scheme).write(scheme_dir / "Jizhang.xcscheme", encoding="utf-8", xml_declaration=True)
    print(f"Generated project: {len(app_refs)} application, {len(shared_refs)} shared, "
          f"{len(widget_refs)} widget and {len(test_refs)} test Swift files.")


if __name__ == "__main__":
    main()

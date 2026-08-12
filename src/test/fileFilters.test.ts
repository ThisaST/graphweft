import * as assert from 'assert';
import { isGeneratedArtifact, isSupportedSourcePath } from '../utils/fileFilters';

(function rejectsDotNetBuildOutput(): void {
  assert.ok(!isSupportedSourcePath('Axon.Docs.Wasm/obj/Release/net10.0/Axon.Docs.Wasm.GlobalUsings.g.cs'));
  assert.ok(!isSupportedSourcePath('src/bin/Debug/net8.0/App.dll.config'));
  assert.ok(!isSupportedSourcePath('proj/obj/Debug/net9.0/.NETCoreApp,Version=v9.0.AssemblyAttributes.cs'));
})();

(function rejectsGeneratedCSharpEvenInSourceDirs(): void {
  assert.ok(isGeneratedArtifact('App/App.GlobalUsings.g.cs'), 'GlobalUsings.g.cs is generated');
  assert.ok(isGeneratedArtifact('Forms/MainForm.Designer.cs'), 'Designer.cs is generated');
  assert.ok(isGeneratedArtifact('Foo.AssemblyInfo.cs'), 'project-prefixed AssemblyInfo.cs is generated');
  assert.ok(!isGeneratedArtifact('Properties/AssemblyInfo.cs'), 'hand-written Properties/AssemblyInfo.cs is kept');
  assert.ok(!isSupportedSourcePath('App/App.GlobalUsings.g.cs'));
})();

(function rejectsBlazorWasmRuntimeAssets(): void {
  assert.ok(!isSupportedSourcePath('wwwroot/_framework/dotnet.runtime.q5rqv3xrhm.js'));
  assert.ok(!isSupportedSourcePath('wwwroot/_framework/blazor.webassembly.js'));
  assert.ok(!isSupportedSourcePath('wwwroot/_framework/dotnet.native.js'));
  assert.ok(isGeneratedArtifact('wwwroot/Axon.min.js'));
  assert.ok(!isSupportedSourcePath('wwwroot/Axon.min.js'));
})();

(function rejectsCommonBuildDirs(): void {
  for (const p of [
    'node_modules/react/index.js',
    'target/debug/main.rs',
    'vendor/github.com/pkg/errors/errors.go',
    'dist/app.js',
    '.next/server/page.js',
  ]) {
    assert.ok(!isSupportedSourcePath(p), `should exclude ${p}`);
  }
})();

(function rejectsCrossLanguageBuildDirs(): void {
  for (const p of [
    'app/.venv/lib/python3.12/site-packages/foo.py',           // Python venv
    'service/vendor/golang.org/x/net/http.go',                 // Go vendor
    'rustsvc/target/debug/build/main.rs',                      // Rust target
    'android/.gradle/caches/x.kt',                             // Gradle cache
    'iosapp/Pods/Alamofire/Source/Request.swift',             // CocoaPods
    'iosapp/.build/checkouts/swift-nio/Sources/x.swift',      // SwiftPM
    'phoenix/_build/dev/lib/app/ebin/app.ex',                 // Elixir build
    'phoenix/deps/phoenix/lib/phoenix.ex',                    // Elixir deps
    'flutter/.dart_tool/package_config.json',                 // Dart tool
    'cpp/cmake-build-debug/CMakeFiles/x.cpp',                 // CMake output
    'infra/.terraform/modules/vpc/main.tf',                   // Terraform
  ]) {
    assert.ok(!isSupportedSourcePath(p), `should exclude ${p}`);
  }
})();

(function rejectsCrossLanguageGeneratedFiles(): void {
  assert.ok(isGeneratedArtifact('api/user.pb.go'), 'go protobuf');
  assert.ok(isGeneratedArtifact('api/user_pb2.py'), 'python protobuf');
  assert.ok(isGeneratedArtifact('api/user_pb2_grpc.py'), 'python grpc');
  assert.ok(isGeneratedArtifact('api/user.pb.h'), 'c++ protobuf header');
  assert.ok(isGeneratedArtifact('src/Models.generated.cs'), '*.generated.cs');
  assert.ok(isGeneratedArtifact('package-lock.json'), 'npm lockfile');
  assert.ok(isGeneratedArtifact('pnpm-lock.yaml'), 'pnpm lockfile');
  assert.ok(!isSupportedSourcePath('api/user.pb.go'));
  assert.ok(!isSupportedSourcePath('package-lock.json'));
})();

(function keepsRealSource(): void {
  for (const p of [
    'src/Services/UserService.cs',
    'Controllers/HomeController.cs',
    'src/app/main.ts',
    'pkg/util/log.go',
    'lib/parser.py',
    'Components/Popover.razor.cs',
  ]) {
    assert.ok(isSupportedSourcePath(p), `should keep ${p}`);
  }
})();

(function windowsPathsNormalized(): void {
  assert.ok(!isSupportedSourcePath('C:\\repo\\proj\\obj\\Release\\net10.0\\Thing.g.cs'));
  assert.ok(isSupportedSourcePath('C:\\repo\\src\\Thing.cs'));
})();

console.log('fileFilters.test.ts passed');

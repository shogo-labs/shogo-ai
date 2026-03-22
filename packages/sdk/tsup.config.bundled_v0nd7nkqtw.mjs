// tsup.config.ts
import { defineConfig } from "tsup";
var tsup_config_default = defineConfig({
  entry: [
    "src/index.ts",
    "src/db/index.ts",
    "src/react/index.ts",
    "src/generators/index.ts",
    "src/email/index.ts",
    "src/email/server.ts"
  ],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  target: "es2020",
  outDir: "dist",
  external: [
    "react",
    "mobx",
    "mobx-react-lite",
    "@prisma/client",
    "@prisma/internals",
    "@prisma/adapter-pg",
    "@prisma/adapter-libsql",
    "nodemailer",
    "@aws-sdk/client-ses"
  ]
});
export {
  tsup_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidHN1cC5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9faW5qZWN0ZWRfZmlsZW5hbWVfXyA9IFwiL1VzZXJzL3JpdGh3aWsvcml0aHdpay9vZGluL3Nob2dvLWFpL3BhY2thZ2VzL3Nkay90c3VwLmNvbmZpZy50c1wiO2NvbnN0IF9faW5qZWN0ZWRfZGlybmFtZV9fID0gXCIvVXNlcnMvcml0aHdpay9yaXRod2lrL29kaW4vc2hvZ28tYWkvcGFja2FnZXMvc2RrXCI7Y29uc3QgX19pbmplY3RlZF9pbXBvcnRfbWV0YV91cmxfXyA9IFwiZmlsZTovLy9Vc2Vycy9yaXRod2lrL3JpdGh3aWsvb2Rpbi9zaG9nby1haS9wYWNrYWdlcy9zZGsvdHN1cC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd0c3VwJ1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBlbnRyeTogW1xuICAgICdzcmMvaW5kZXgudHMnLFxuICAgICdzcmMvZGIvaW5kZXgudHMnLFxuICAgICdzcmMvcmVhY3QvaW5kZXgudHMnLFxuICAgICdzcmMvZ2VuZXJhdG9ycy9pbmRleC50cycsXG4gICAgJ3NyYy9lbWFpbC9pbmRleC50cycsXG4gICAgJ3NyYy9lbWFpbC9zZXJ2ZXIudHMnLFxuICBdLFxuICBmb3JtYXQ6IFsnY2pzJywgJ2VzbSddLFxuICBkdHM6IHRydWUsXG4gIGNsZWFuOiB0cnVlLFxuICBzb3VyY2VtYXA6IHRydWUsXG4gIG1pbmlmeTogZmFsc2UsXG4gIHRhcmdldDogJ2VzMjAyMCcsXG4gIG91dERpcjogJ2Rpc3QnLFxuICBleHRlcm5hbDogW1xuICAgICdyZWFjdCcsXG4gICAgJ21vYngnLFxuICAgICdtb2J4LXJlYWN0LWxpdGUnLFxuICAgICdAcHJpc21hL2NsaWVudCcsXG4gICAgJ0BwcmlzbWEvaW50ZXJuYWxzJyxcbiAgICAnQHByaXNtYS9hZGFwdGVyLXBnJyxcbiAgICAnQHByaXNtYS9hZGFwdGVyLWxpYnNxbCcsXG4gICAgJ25vZGVtYWlsZXInLFxuICAgICdAYXdzLXNkay9jbGllbnQtc2VzJyxcbiAgXSxcbn0pXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQWlTLFNBQVMsb0JBQW9CO0FBRTlULElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLE9BQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFRLENBQUMsT0FBTyxLQUFLO0FBQUEsRUFDckIsS0FBSztBQUFBLEVBQ0wsT0FBTztBQUFBLEVBQ1AsV0FBVztBQUFBLEVBQ1gsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUFBLEVBQ1IsVUFBVTtBQUFBLElBQ1I7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=

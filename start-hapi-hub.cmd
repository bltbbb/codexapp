@echo off
set HAPI_LISTEN_HOST=0.0.0.0
set HAPI_PUBLIC_URL=http://100.100.140.116:3006
"C:\Program Files\nodejs\node_modules\@twsxtd\hapi\node_modules\@twsxtd\hapi-win32-x64\bin\hapi.exe" hub --no-relay

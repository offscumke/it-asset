@echo off
:: 在 Windows 机器上运行此脚本，自动构建 it-asset-agent.exe
:: 需要先安装 Python 3.x (python.org)

echo =^> 安装依赖...
pip install pyinstaller psutil --quiet

echo =^> 下载 agent.py...
:: 把 agent.py 放到和此脚本同目录，或修改下面的路径
pyinstaller --onefile --name it-asset-agent --noconsole agent.py

echo =^> 构建完成: dist\it-asset-agent.exe
pause

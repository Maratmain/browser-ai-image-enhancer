from __future__ import annotations

import torch
from torch import nn


class TinyEnhancerCNN(nn.Module):
    """A dependency-free exportable CNN that predicts global correction parameters."""

    def __init__(self) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(3, 8, kernel_size=3, stride=2, padding=1)
        self.dw2 = nn.Conv2d(8, 8, kernel_size=3, stride=2, padding=1, groups=8)
        self.pw2 = nn.Conv2d(8, 16, kernel_size=1)
        self.dw3 = nn.Conv2d(16, 16, kernel_size=3, stride=2, padding=1, groups=16)
        self.pw3 = nn.Conv2d(16, 24, kernel_size=1)
        self.dw4 = nn.Conv2d(24, 24, kernel_size=3, stride=2, padding=1, groups=24)
        self.pw4 = nn.Conv2d(24, 32, kernel_size=1)
        self.fc1 = nn.Linear(32, 16)
        self.fc2 = nn.Linear(16, 4)
        self.activation = nn.ReLU()

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        x = self.activation(self.conv1(image))
        x = self.activation(self.pw2(self.dw2(x)))
        x = self.activation(self.pw3(self.dw3(x)))
        x = self.activation(self.pw4(self.dw4(x)))
        x = x.mean(dim=(2, 3))
        x = self.activation(self.fc1(x))
        return self.fc2(x)


def transform_outputs(raw: torch.Tensor) -> torch.Tensor:
    exposure = torch.tanh(raw[:, 0]) * 1.25
    contrast = 1.0 + torch.tanh(raw[:, 1]) * 0.45
    saturation = 1.0 + torch.tanh(raw[:, 2]) * 0.50
    strength = torch.sigmoid(raw[:, 3])
    return torch.stack((exposure, contrast, saturation, strength), dim=1)

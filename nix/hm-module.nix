# Home Manager module for canarycode (CanaryCode). Imported by flake.nix as
# `homeManagerModules.default`, curried with the flake's `self` so the default
# package resolves to this flake's release for the user's system.
#
# Usage (in a Home Manager config that has this flake as an input named `canarycode`):
#
#   imports = [ canarycode.homeManagerModules.default ];
#   programs.canarycode = {
#     enable = true;
#     # optional — when set, renders a read-only ~/.canarycode/config.json:
#     settings = {
#       model = "opus";
#       thinking = "off";
#     };
#   };
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.canarycode;
in
{
  options.programs.canarycode = {
    enable = lib.mkEnableOption "canarycode, a fast minimal terminal coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "canarycode.packages.\${system}.default";
      description = "The canarycode package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.nullOr (lib.types.attrsOf lib.types.anything);
      default = null;
      description = ''
        Declarative contents of ~/.canarycode/config.json. When set, the file is managed
        by Home Manager (read-only). When null (the default), the config file is
        left mutable and user-managed, as `canarycode` writes it itself.
      '';
      example = lib.literalExpression ''
        {
          model = "opus";
          thinking = "off";
          autoUpdate.enabled = false;
        }
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Self-update is already disabled by the package wrapper (CANARYCODE_DISABLE_UPDATE=1);
    # only manage the config file when the user opts in with `settings`.
    home.file.".canarycode/config.json" = lib.mkIf (cfg.settings != null) {
      text = builtins.toJSON cfg.settings;
    };
  };
}

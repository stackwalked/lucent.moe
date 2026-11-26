-- Piece 2 of community: a role may carry a label colour. Null means the role shows no label
-- member-side; a colour names one of the six hues the web tokens define. Permissions are not
-- involved: the colour is display only.
alter table role
    add column label_color text check (label_color is null or label_color in ('pink', 'shu', 'ok', 'wait', 'violet', 'aqua'));
